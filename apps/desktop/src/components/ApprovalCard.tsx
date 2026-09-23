import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import { useAppStore } from "../lib/store";
import { describeApprovalScope, formatArgs, humanizeToolName, shortcutLabel, summarizeArgs } from "../lib/format";
import { approvalPreview, type ApprovalPreview } from "../lib/approvalPreview";
import { parseUnifiedDiff, type DiffLine } from "../lib/diff";

const EXPIRY_NOTICE_MS = 5 * 60 * 1000;
const PATCH_LINE_CAP = 200;
const WRITE_LINE_CAP = 40;

const diffLineClass = (type: DiffLine["type"]) => type === "add" ? "plus" : type === "del" ? "minus" : type === "hunk" ? "hunk" : type === "meta" ? "meta" : "ctx";

function ApprovalPreviewView({ preview }: { preview: NonNullable<ApprovalPreview> }) {
  if (preview.kind === "replace") {
    return (
      <div className="diff approval-diff" aria-label="Proposed change">
        {preview.path ? <div className="meta">{preview.path}</div> : null}
        {preview.before.split("\n").map((line, index) => <div key={`old-${index}`} className="minus">- {line}</div>)}
        {preview.after.split("\n").map((line, index) => <div key={`new-${index}`} className="plus">+ {line}</div>)}
      </div>
    );
  }
  if (preview.kind === "patch") {
    const file = parseUnifiedDiff(preview.diff).files[0];
    if (!file) return null;
    const lines = file.lines.slice(0, PATCH_LINE_CAP);
    const more = file.lines.length - lines.length;
    return (
      <div className="diff approval-diff" aria-label="Proposed patch">
        {file.header.map((line, index) => <div key={`h-${index}`} className="meta">{line}</div>)}
        {lines.map((line, index) => <div key={index} className={diffLineClass(line.type)}>{line.text}</div>)}
        {more > 0 ? <div className="meta">…{more} more lines</div> : null}
      </div>
    );
  }
  const lines = preview.content.split("\n");
  const shown = lines.slice(0, WRITE_LINE_CAP);
  return (
    <div className="diff approval-diff" aria-label="Proposed file content">
      {preview.path ? <div className="meta">{preview.path}</div> : null}
      {shown.map((line, index) => <div key={index} className="plus">+ {line}</div>)}
      {lines.length > shown.length ? <div className="meta">…{lines.length - shown.length} more lines</div> : null}
    </div>
  );
}

export function ApprovalCard() {
  const thread = useAppStore((s) => s.threads.find((t) => t.sessionId === s.selectedSessionId));
  const decide = useAppStore((s) => s.decide);
  const approval = thread?.pendingApproval;
  const expiresAt = approval?.expiresAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!expiresAt || expiresAt <= Date.now()) return;
    const timer = window.setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= expiresAt) window.clearInterval(timer);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);
  if (!approval) return null;
  const toolLabel = humanizeToolName(approval.toolName);
  const summary = summarizeArgs(approval.toolName, approval.rawArgs);
  const details = approval.rawArgs && approval.rawArgs !== summary ? formatArgs(approval.rawArgs) : "";
  const preview = approvalPreview(approval.toolName, approval.rawArgs);
  const allow = approval.availableChoices.filter((choice) => !choice.decision.startsWith("denied"));
  const deny = approval.availableChoices.filter((choice) => choice.decision.startsWith("denied"));
  const subject = approval.subject && typeof approval.subject.kind === "string"
    ? [String(approval.subject.kind), typeof approval.subject.path === "string" ? approval.subject.path : typeof approval.subject.workspaceRoot === "string" ? approval.subject.workspaceRoot : ""].filter(Boolean).join(" · ")
    : "";
  const remaining = expiresAt != null ? expiresAt - now : null;
  const expired = remaining != null && remaining <= 0;
  const showCountdown = remaining != null && !expired && remaining < EXPIRY_NOTICE_MS;
  const countdown = remaining != null ? `${Math.floor(remaining / 60000)}:${String(Math.floor((remaining % 60000) / 1000)).padStart(2, "0")}` : "";
  const disabled = thread?.approvalPending || thread?.cancelRequested || expired;
  const more = thread?.queuedApprovals?.length ?? 0;
  const scopeNote = describeApprovalScope(allow[0]?.scope ?? "");
  return (
    <section className="approval" aria-label="Approval required">
      <header className="approval-head">
        <span className="approval-icon"><ShieldAlert size={14} aria-hidden="true" /></span>
        <div>
          <h3>Allow {toolLabel}?</h3>
          {subject ? <p className="muted">{subject}</p> : null}
          {more ? <p className="muted">+{more} more waiting</p> : null}
        </div>
      </header>
      {preview ? <ApprovalPreviewView preview={preview} /> : null}
      {summary ? <pre className="cmd">{summary}</pre> : null}
      {details ? <details className="approval-args"><summary>Full arguments</summary><pre className="cmd">{details}</pre></details> : null}
      {expired ? <p className="muted approval-expiry" role="status">This approval expired. Stop or re-run the turn.</p> : null}
      <div className="choices">
        {deny.map((choice, index) => (
          <button key={choice.choiceId} disabled={disabled} title={describeApprovalScope(choice.scope) || undefined} className="secondary" onClick={() => void decide(approval.approvalId, choice.choiceId)}>{choice.label}{index === 0 ? <kbd>{shortcutLabel("⌫")}</kbd> : null}</button>
        ))}
        <span className="grow" />
        {allow.map((choice, index) => (
          <button key={choice.choiceId} disabled={disabled} title={describeApprovalScope(choice.scope) || undefined} className={index === 0 ? "primary accent" : "secondary"} onClick={() => void decide(approval.approvalId, choice.choiceId)}>{choice.label}{index === 0 ? <kbd>{shortcutLabel("Y")}</kbd> : index === 1 ? <kbd>{shortcutLabel("⇧Y")}</kbd> : null}</button>
        ))}
      </div>
      {scopeNote ? <p className="muted approval-scope">{scopeNote}</p> : null}
      {showCountdown ? <p className="muted approval-expiry">Expires in {countdown}</p> : null}
    </section>
  );
}
