import { useState } from "react";
import { useAppStore } from "../lib/store";
import { AGENT_LABELS, type UserInputAnswer, type UserInputRequest, type UserInputResponse } from "../lib/types";

type AnswerDraft = { text?: string; labels?: string[]; freeText?: boolean };

export function UserInputCards() {
  const thread = useAppStore((state) => state.threads.find((item) => item.sessionId === state.selectedSessionId));
  const agentId = thread?.agentId ?? "muse";
  const agentName = useAppStore((state) => state.agents.find((agent) => agent.id === agentId)?.name ?? AGENT_LABELS[agentId]);
  return <>{thread?.userInputs?.map((request) => <UserInputCard
    key={`${request.sessionId}:${request.userInputId}`} request={request}
    agentName={agentName}
    disabled={Boolean(thread.userInputPending || thread.cancelRequested || !thread.opened)}
  />)}</>;
}

export function UserInputCard({ request, disabled, agentName = "Muse" }: { request: UserInputRequest; disabled: boolean; agentName?: string }) {
  const respond = useAppStore((state) => state.respondUserInput);
  const [drafts, setDrafts] = useState<Record<string, AnswerDraft>>({});
  const [clarifying, setClarifying] = useState(false);
  const [clarification, setClarification] = useState("");
  const [error, setError] = useState("");
  const edit = (id: string, patch: AnswerDraft) => setDrafts((current) => ({ ...current, [id]: { ...current[id], ...patch } }));
  const send = (response: UserInputResponse) => {
    setError("");
    void respond(request.sessionId, request.userInputId, response);
  };
  const submit = () => {
    const answers: UserInputAnswer[] = [];
    for (const question of request.questions) {
      const draft = drafts[question.id] ?? {};
      if (draft.freeText || !question.options.length) {
        if (!draft.text?.trim()) { setError(`Enter an answer for ${question.header || question.question}.`); return; }
        answers.push({ questionId: question.id, freeText: draft.text.trim() });
      } else {
        const labels = draft.labels ?? [];
        const multiple = question.selection.mode === "multiple";
        const min = multiple ? question.selection.minSelections ?? 1 : 1;
        const max = multiple ? question.selection.maxSelections ?? question.options.length : 1;
        if (labels.length < min || labels.length > max) {
          setError(`Choose ${min === max ? min : `${min}–${max}`} option(s) for ${question.header || question.question}.`);
          return;
        }
        answers.push(multiple ? { questionId: question.id, selectedLabels: labels } : { questionId: question.id, selectedLabel: labels[0] });
      }
    }
    send({ action: "answer", answers });
  };
  return <section className="approval user-input" aria-label={`${agentName} needs your input`}>
    <h3>{agentName} needs your input</h3>
    <fieldset disabled={disabled} className="settings-fields">
      {clarifying ? <label className="field">Explain what {agentName} should consider instead
        <textarea rows={3} maxLength={500} value={clarification} onChange={(event) => setClarification(event.target.value)} />
      </label> : request.questions.map((question) => {
        const draft = drafts[question.id] ?? {};
        const freeText = draft.freeText || !question.options.length;
        const multiple = question.selection.mode === "multiple";
        return <fieldset className="question" key={question.id}>
          <legend>{question.header ? `${question.header}: ` : ""}{question.question}</legend>
          {!freeText && question.options.map((option) => <label className="question-option" key={option.label}>
            <input type={multiple ? "checkbox" : "radio"} name={`${request.userInputId}:${question.id}`}
              checked={draft.labels?.includes(option.label) ?? false}
              onChange={(event) => edit(question.id, { labels: multiple ? event.target.checked ? [...(draft.labels ?? []), option.label] : (draft.labels ?? []).filter((label) => label !== option.label) : [option.label] })} />
            <span>{option.label}{option.description && <small>{option.description}</small>}{option.preview && <pre>{option.preview.content}</pre>}</span>
          </label>)}
          {freeText && <textarea aria-label={`Answer: ${question.question}`} rows={3} maxLength={500} value={draft.text ?? ""} onChange={(event) => edit(question.id, { text: event.target.value })} />}
          {question.options.length > 0 && <button type="button" className="text-btn" onClick={() => edit(question.id, { freeText: !freeText })}>{freeText ? "Choose from options" : "Write another answer"}</button>}
        </fieldset>;
      })}
      {error && <p role="alert">{error}</p>}
      <div className="choices">
        <button type="button" className="primary" disabled={clarifying && !clarification.trim()} onClick={() => clarifying ? send({ action: "clarify", text: clarification.trim() }) : submit()}>{clarifying ? "Send explanation" : "Send answers"}</button>
        <button type="button" className="chip" onClick={() => { setClarifying(!clarifying); setError(""); }}>{clarifying ? "Back to questions" : "Let me explain"}</button>
        <button type="button" className="text-btn" onClick={() => send({ action: "cancel" })}>Decline to answer</button>
      </div>
    </fieldset>
  </section>;
}
