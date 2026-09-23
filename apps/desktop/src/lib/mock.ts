import type { AgentInfo, Model } from "./types";
import type { GitSnapshot, Thread, TranscriptItem } from "./types";

const now = new Date().toISOString();

const inspectItems: TranscriptItem[] = [
  {
    itemId: "u1",
    kind: "userMessage",
    status: "completed",
    turnId: "turn-1",
    text: "Add a dark command-center layout for the desktop app.",
    refs: [{ id: "r1", kind: "file", path: "apps/desktop/src/App.tsx" }],
    recordedAt: now,
  },
  {
    itemId: "r1",
    kind: "reasoning",
    status: "completed",
    turnId: "turn-1",
    summary: ["Inspect the shell, then introduce a 319px sidebar, a conversation surface, and a review inspector."],
    text: "I'll inspect the authentication of the current chrome, then replace the chat layout with a workspace → thread → run model.",
  },
  {
    itemId: "t-search",
    kind: "toolCall",
    status: "completed",
    turnId: "turn-1",
    tool: "codebase_search",
    args: '{"query":"sidebar conversation layout"}',
    durationMs: 840,
    visibleOutput: "apps/desktop/src/App.tsx\napps/desktop/src/components/Sidebar.tsx",
  },
  {
    itemId: "t1",
    kind: "toolCall",
    status: "completed",
    turnId: "turn-1",
    tool: "read_file",
    args: '{"path":"apps/desktop/src/App.tsx"}',
    durationMs: 120,
    visibleOutput: "export function App() {\n  return <Shell />\n}",
  },
  {
    itemId: "t2",
    kind: "toolCall",
    status: "completed",
    turnId: "turn-1",
    tool: "edit_file",
    args: '{"path":"apps/desktop/src/styles.css"}',
    durationMs: 640,
    visibleOutput: "Updated tokens for surface, ink, and accent.",
  },
  {
    itemId: "t-cmd",
    kind: "toolCall",
    status: "completed",
    turnId: "turn-1",
    tool: "bash",
    commandText: "npm test --silent",
    args: '{"command":"npm test --silent"}',
    exitCode: 0,
    durationMs: 2100,
    visibleOutput: "28 tests passed",
    truncated: true,
    outputRef: { id: "mock-ref-1", kind: "tool_output", uri: "mock:tool-output", availability: "available", byteLen: 2048, mediaType: "text/plain" },
  },
  {
    itemId: "a2",
    kind: "agentMessage",
    status: "completed",
    turnId: "turn-1",
    text: "Implemented the command-center shell: sidebar threads, an agent timeline, and a per-file review dock.\n\n## What changed\n\nThe layout now follows a **workspace → thread → run** model. `App.tsx` only composes the shell; state lives in `lib/store.ts` and streams from the bridge over NDJSON.\n\n### Layers\n\n- **UI** (`apps/desktop/src/components/`) — `Sidebar.tsx`, `ThreadView.tsx`, `AgentTimeline.tsx`, `Composer.tsx`, and `ReviewDock.tsx`. Each renders store state; none talk to the bridge directly.\n- **State** (`lib/store.ts`) — a zustand store holding workspaces, threads, the composer draft, and git status. Selectors like `currentThread` keep renders scoped.\n- **Bridge** (`packages/muse-bridge/`) — hosts `@muse-code/sdk` over `muse serve` stdio and forwards session events as NDJSON lines.\n\n### Data flow\n\n1. The composer calls `sendPrompt`, which writes a `userMessage` item and opens a turn.\n2. Bridge events fold into `thread.items` — tool calls, reasoning, and agent messages stream in order.\n3. `AgentTimeline` groups items into runs and renders steps, plans, and the final reply.\n\n```ts\nconst thread = useAppStore(currentThread);\nconst send = useAppStore((s) => s.sendPrompt);\nawait send({ resetTaskState: true });\n```\n\n| Surface | File | Renders |\n|---|---|---|\n| Timeline | `AgentTimeline.tsx` | Steps, plans, receipts |\n| Composer | `Composer.tsx` | Draft, attachments, effort |\n| Review | `ReviewDock.tsx` | Changed files, diffs |\n\n> Threads persist across launches, and an interrupted run is labeled rather than silently dropped.\n\nNext up:\n\n- [ ] Streaming diffs in the review dock\n- [ ] Plan pinning during long runs",
  },
];

export const MOCK_THREADS: Thread[] = [
  {
    sessionId: "preview-1",
    workspacePath: "/Users/you/Muse Code",
    title: "Command center layout",
    updatedAt: now,
    status: "idle",
    unread: false,
    lastOutcome: "completed",
    lastTurnId: "turn-1",
    pinned: true,
    skills: [
      { selector: "review", displayName: "Review", description: "Review the working tree", source: "user" },
      { selector: "plan", displayName: "Plan", description: "Plan before coding", source: "user" },
    ],
    plan: [
      { id: "p1", text: "Inspect the shell", status: "completed" },
      { id: "p2", text: "Introduce the sidebar and review inspector", status: "completed" },
      { id: "p3", text: "Wire Muse sessions", status: "completed" },
    ],
    goal: { objective: "Ship a desktop command center", currentWork: "Reviewing the inspector", nextWork: "Persist threads" },
    context: { usedTokens: 18400, windowTokens: 128000, pressure: "ok" },
    items: inspectItems,
  },
  {
    sessionId: "preview-2",
    workspacePath: "/Users/you/Muse Code",
    title: "Wire muse serve",
    updatedAt: new Date(Date.now() - 3600_000).toISOString(),
    status: "running",
    unread: true,
    activeTurnId: "turn-live",
    lastTurnId: "turn-live",
    pendingApproval: {
      approvalId: "appr-1",
      sessionId: "preview-2",
      turnId: "turn-live",
      toolName: "bash",
      rawArgs: '{"command":"muse serve --workspace ."}',
      availableChoices: [
        { choiceId: "allow-once", label: "Allow once", decision: "approved", scope: "once" },
        { choiceId: "allow-session", label: "Allow for session", decision: "approvedForSession", scope: "session" },
        { choiceId: "deny", label: "Deny", decision: "denied", scope: "once" },
      ],
    },
    plan: [
      { id: "s1", text: "Start muse serve", status: "completed" },
      { id: "s2", text: "Fold live item events", status: "inProgress", activeForm: "Folding live item events" },
      { id: "s3", text: "Restore session facts", status: "pending" },
    ],
    goal: { objective: "Stream Muse turns into the thread", currentWork: "Opening the workspace session", nextWork: "Subscribe to item events" },
    items: [
      {
        itemId: "u2",
        kind: "userMessage",
        status: "completed",
        turnId: "turn-live",
        text: "Spawn muse serve and stream turn items into the thread.",
      },
      {
        itemId: "r2",
        kind: "reasoning",
        status: "completed",
        turnId: "turn-live",
        summary: ["Open a session on the workspace root, then fold live item events into the timeline."],
      },
      {
        itemId: "t-live-read",
        kind: "toolCall",
        status: "completed",
        turnId: "turn-live",
        tool: "read_file",
        args: '{"path":"packages/muse-bridge/src/host.ts"}',
        durationMs: 90,
        visibleOutput: "export async function startHost() { … }",
      },
      {
        itemId: "sub-live",
        kind: "subagent",
        status: "completed",
        turnId: "turn-live",
        subagentId: "mock-kid-1",
        childSessionId: "preview-child-1",
        controlStatus: "resultReady",
        role: "auditor",
        objective: "Audit the composer for focus traps",
        durationMs: 9400,
        result: { summary: "Two focus traps found and fixed.", text: "The palette and the preview dialog now trap focus while open.", artifactRefs: ["apps/desktop/src/components/CommandPalette.tsx"], evidenceRefs: [] },
      },
      {
        itemId: "t-bg",
        kind: "toolCall",
        status: "inProgress",
        turnId: "turn-live",
        tool: "bash",
        commandText: "npm run soak --silent",
        args: '{"command":"npm run soak --silent"}',
        background: true,
        backgroundInitiator: "user",
        visibleOutput: "soak 412/2000…",
      },
      {
        itemId: "w-live",
        kind: "workflow",
        status: "inProgress",
        turnId: "turn-live",
        entryId: "release-readiness",
        workflowRunId: "mock-run-1",
        children: [
          { childId: "ux", attempt: 1, status: "terminal", terminal: "completed", label: "Conversation UX", phase: "Reviewed edge states", durationMs: 18200, usage: { outputTokens: 840 } },
          { childId: "tests", attempt: 1, status: "started", label: "Reliability checks", phase: "Running cancellation tests" },
          { childId: "accessibility", attempt: 1, status: "accepted", label: "Accessibility pass", phase: "Queued" },
        ],
      },
      {
        itemId: "t-live",
        kind: "toolCall",
        status: "inProgress",
        turnId: "turn-live",
        tool: "bash",
        commandText: "muse serve --workspace .",
        args: '{"command":"muse serve --workspace ."}',
        visibleOutput: "listening on 127.0.0.1…",
      },
    ],
  },
  {
    sessionId: "preview-3",
    workspacePath: "/Users/you/Muse Code",
    title: "Interrupted auth refresh",
    updatedAt: new Date(Date.now() - 7200_000).toISOString(),
    status: "error",
    unread: false,
    lastOutcome: "interrupted",
    lastTurnId: "turn-3",
    items: [
      {
        itemId: "u3",
        kind: "userMessage",
        status: "completed",
        turnId: "turn-3",
        text: "Find where sessions are persisted and fix silent token refresh failures.",
      },
      {
        itemId: "t3",
        kind: "toolCall",
        status: "completed",
        turnId: "turn-3",
        tool: "grep",
        args: '{"pattern":"refreshToken"}',
        durationMs: 210,
        visibleOutput: "src/lib/settingsPersistence.ts",
      },
      {
        itemId: "t3b",
        kind: "toolCall",
        status: "failed",
        turnId: "turn-3",
        tool: "bash",
        commandText: "npm test tests/auth.test.mjs",
        args: '{"command":"npm test tests/auth.test.mjs"}',
        exitCode: 1,
        durationMs: 1300,
        failureReason: "Test file not found. The run stopped when Muse disconnected.",
      },
    ],
  },
];

export function mockThreads(): Thread[] {
  return MOCK_THREADS.map((thread) => ({ ...thread, items: thread.items.map((item) => ({ ...item })) }));
}

export const MOCK_GIT: GitSnapshot = {
  branch: "main",
  dirty: true,
  files: [
    { path: "apps/desktop/src/App.tsx", status: "M", added: 42, removed: 8 },
    { path: "apps/desktop/src/styles.css", status: "A", added: 180, removed: 0 },
    { path: "packages/muse-bridge/src/host.ts", status: "A", added: 96, removed: 0 },
  ],
  diff: `diff --git a/apps/desktop/src/App.tsx b/apps/desktop/src/App.tsx
@@ -1,6 +1,18 @@
-export function App() {
-  return <div>Muse</div>
-}
+export function App() {
+  return (
+    <div className="shell">
+      <Sidebar />
+      <ThreadView />
+      <ReviewDock />
+    </div>
+  )
+}
`,
};

export const MOCK_MODELS: Model[] = [
  { modelId: "muse-spark-1.3", displayLabel: "muse-spark-1.3", isActive: true, contextLimit: 1007997, cost: { input: "1.25", output: "4.25", currency: "USD" }, reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "high", effortSource: "vocabulary" },
  { modelId: "muse-spark-1.3-contributor", displayLabel: "muse-spark-1.3-contributor", isDefault: true, contextLimit: 1007997, cost: { input: "0.10", output: "0.20", currency: "USD" }, description: "Discounted tokens: your content, including inter-session messages, may be used for product improvement.", reasoningEfforts: ["none", "minimal", "low", "medium", "high", "xhigh", "max"], defaultReasoningEffort: "high", effortSource: "vocabulary" },
  { modelId: "muse-spark-1.2", displayLabel: "muse-spark-1.2", isActive: false, contextLimit: 1007997, cost: { input: "1.25", output: "4.25", currency: "USD" }, reasoningEfforts: ["low", "medium", "high", "max"], defaultReasoningEffort: "medium", effortSource: "host" },
];

export const MOCK_AGENTS: AgentInfo[] = [
  { id: "muse", name: "Muse", protocol: "msp", found: true, path: "/usr/local/bin/muse", version: "1.3.0", verified: true, signIn: "", authenticated: true },
  { id: "opencode", name: "OpenCode", protocol: "acp", found: true, path: "/opt/homebrew/bin/opencode", version: "1.18.31", verified: true, signIn: "" },
  { id: "grok", name: "Grok", protocol: "acp", found: true, path: "~/.grok/bin/grok", version: "1.0.34", verified: true, signIn: "" },
  { id: "gemini", name: "Gemini CLI", protocol: "acp", found: false, path: null, version: null, verified: false, signIn: "" },
  { id: "qwen", name: "Qwen Code", protocol: "acp", found: false, path: null, version: null, verified: false, signIn: "" },
  { id: "goose", name: "Goose", protocol: "acp", found: false, path: null, version: null, verified: false, signIn: "" },
];

const zen = (id: string, name: string, input: string, output: string, efforts: Model["reasoningEfforts"] = [], context = 200000): Model =>
  ({ modelId: `opencode/${id}`, displayLabel: name, providerId: "opencode", contextLimit: context, cost: { input, output, currency: "USD" }, description: input === "0" && output === "0" ? "Free" : null, reasoningEfforts: efforts, effortSource: "host" });

export const MOCK_AGENT_MODELS: Record<string, Model[]> = {
  opencode: [
    zen("claude-opus-5", "Claude Opus 5", "5", "25", ["low", "medium", "high", "xhigh", "max"], 1000000),
    zen("claude-sonnet-5", "Claude Sonnet 5", "3", "15", ["low", "medium", "high", "xhigh", "max"], 1000000),
    zen("claude-haiku-4-5", "Claude Haiku 4.5", "1", "5", ["high", "max"]),
    zen("gpt-5.5", "GPT-5.5", "1.25", "10", ["low", "medium", "high", "xhigh"], 400000),
    zen("gemini-3.5-flash", "Gemini 3.5 Flash", "0.3", "2.5", ["low", "medium", "high"], 1000000),
    zen("big-pickle", "Big Pickle", "0", "0"),
    zen("mimo-v2.5-free", "MiMo V2.5 (free)", "0", "0"),
    zen("nemotron-3.5-lightning-free", "Nemotron 3.5 Lightning (free)", "0", "0"),
    zen("muse-spark-1.3-contributor-free", "Muse Spark 1.3 Contributor (free)", "0", "0"),
    zen("glm-5.3", "GLM-5.3", "0.6", "2.2", [], 200000),
    { modelId: "openrouter/qwen/qwen3.8-27b:free", displayLabel: "Qwen3.8 27B (free)", providerId: "openrouter", reasoningEfforts: [], effortSource: "host", description: "Free" },
  ],
  grok: [
    { modelId: "grok-4.6", displayLabel: "Grok 4.6", providerId: "grok", contextLimit: 500000, description: "SpaceXAI's latest frontier model", isDefault: true, reasoningEfforts: ["low", "medium", "high", "xhigh"], defaultReasoningEffort: "high", effortSource: "host" },
    { modelId: "grok-4.5", displayLabel: "Grok 4.5", providerId: "grok", contextLimit: 500000, reasoningEfforts: ["low", "medium", "high"], defaultReasoningEffort: "high", effortSource: "host" },
  ],
};
