/** Shared, browser-safe policy for diagnostics. Never apply to session content. */
export const REDACTED = "[redacted sensitive diagnostic]";
export const DIAGNOSTIC_LIMIT = 8192;

export function sensitiveField(key: string): boolean {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  return /(?:apikey|accesstoken|refreshtoken|idtoken|authtoken|password|passwd|clientsecret|privatekey|authorization|cookie|secret)$/.test(normalized)
    || normalized === "token" || normalized === "key" || /(?:^|_)token$/i.test(key);
}

const ASSIGNMENT = /(?:["']?(?:[a-z0-9_-]*(?:api[_-]?key|token|password|passwd|secret|private[_-]?key)|authorization|cookie|set-cookie)["']?\s*[:=])/i;
const CREDENTIAL = /\b(?:bearer|basic)\s+\S+|-----BEGIN[ A-Z]*PRIVATE KEY-----|\b(?:sk-[a-z0-9_-]{12,}|gh[pousr]_[a-z0-9]{16,}|github_pat_[a-z0-9_]{16,})\b/i;
const URL_SECRET = /[?&](?:code|sig|signature|credential|x-amz-credential|x-amz-signature)=/i;
const USERINFO = /[a-z][a-z0-9+.-]*:\/\/[^\s/]*@/i;

/**
 * Credential formats that need no label: each has a distinctive fixed prefix or
 * shape, so a bare occurrence is still safe to suppress. Case-sensitive on
 * purpose — these alphabets are part of the format (JWT `eyJ` is base64 `{"`).
 * Pure-hex hashes, UUIDs and fingerprints deliberately fall through: they are
 * common diagnostic content and not credentials.
 */
const UNLABELLED = /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|\b(?:AKIA|ASIA|ABIA|ACCA)[0-9A-Z]{16}\b|\bxox[baprs]-[0-9A-Za-z-]{10,}\b|\bnpm_[A-Za-z0-9]{36}\b|\bAIza[0-9A-Za-z_-]{35}\b|\b[srp]k_live_[0-9A-Za-z]{16,}\b|\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b|\bAGE-SECRET-KEY-1[0-9A-Za-z]{20,}\b|\bshp(?:at|ca|pa)_[0-9a-fA-F]{32}\b|\blin_api_[0-9A-Za-z]{20,}\b|\bglpat-[0-9A-Za-z_-]{20,}\b|\bpypi-[A-Za-z0-9_-]{16,}\b|\bdp\.pt\.[A-Za-z0-9]{20,}\b/;

const TOKEN_CHAR = /[A-Za-z0-9_-]/;
/**
 * Unlabelled high-entropy runs formats above miss: 45+ token chars mixing
 * upper, lower and digit classes. Hex hashes are single-case and UUIDs are
 * too short, so git SHAs, fingerprints and ids stay visible.
 */
function unlabelledEntropy(text: string): boolean {
  let length = 0, lower = false, upper = false, digit = false;
  for (const ch of text) {
    if (TOKEN_CHAR.test(ch)) {
      length += 1;
      if (ch >= "a" && ch <= "z") lower = true;
      else if (ch >= "A" && ch <= "Z") upper = true;
      else if (ch >= "0" && ch <= "9") digit = true;
      if (length >= 45 && lower && upper && digit) return true;
    } else {
      length = 0; lower = false; upper = false; digit = false;
    }
  }
  return false;
}

export class DiagnosticRedactor {
  private secrets = new Set<string>();

  remember(values: Record<string, string | undefined | null>) {
    for (const [key, value] of Object.entries(values)) {
      if (sensitiveField(key) && value && value.length >= 4 && value.length <= DIAGNOSTIC_LIMIT && this.secrets.size < 256) {
        this.secrets.add(value);
      }
    }
  }

  text(value: string): string {
    // Fail closed for oversized diagnostics instead of truncating away a label
    // and leaving an unlabelled credential fragment visible.
    if (value.length > DIAGNOSTIC_LIMIT) return "[diagnostic omitted: size limit]";
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch {
      // A malformed unrelated escape must not hide an encoded credential label.
      decoded = value.replace(/%([0-9a-f]{2})/gi, (_, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    }
    if (ASSIGNMENT.test(decoded) || CREDENTIAL.test(decoded) || USERINFO.test(decoded) || URL_SECRET.test(decoded) || UNLABELLED.test(decoded)
      || UNLABELLED.test(value) || unlabelledEntropy(decoded) || unlabelledEntropy(value)) return REDACTED;
    for (const secret of this.secrets) {
      if (value.includes(secret) || decoded.includes(secret)) return REDACTED;
    }
    return value;
  }

  value(value: unknown): unknown {
    let remaining = 256;
    const seen = new WeakSet<object>();
    const visit = (input: unknown, depth: number): unknown => {
      if (--remaining < 0 || depth > 8) return "[diagnostic omitted: structure limit]";
      if (typeof input === "string") return this.text(input);
      if (input === null || typeof input === "number" || typeof input === "boolean") return input;
      if (typeof input !== "object") return String(input);
      if (seen.has(input)) return "[circular]";
      seen.add(input);
      if (input instanceof Error) return visit({ name: input.name, message: input.message, cause: "cause" in input ? input.cause : undefined }, depth + 1);
      if (Array.isArray(input)) return input.slice(0, 64).map((item) => visit(item, depth + 1));
      return Object.fromEntries(Object.entries(input).slice(0, 64).map(([key, item]) => [
        this.text(key), sensitiveField(key) ? REDACTED : visit(item, depth + 1),
      ]));
    };
    return visit(value, 0);
  }
}

export const diagnostics = new DiagnosticRedactor();

/** Buffer whole stderr lines so credentials split across chunks cannot leak. */
export class DiagnosticLines {
  private pending = "";
  private overflow = false;
  private privateKey = false;
  constructor(private readonly emit: (line: string) => void, private readonly redactor = diagnostics) {}

  push(chunk: string) {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf("\n", offset);
      const end = newline < 0 ? chunk.length : newline;
      const room = DIAGNOSTIC_LIMIT - this.pending.length;
      this.pending += chunk.slice(offset, Math.min(end, offset + room));
      if (end - offset > room) this.overflow = true;
      if (newline < 0) return;
      this.flush();
      offset = newline + 1;
    }
  }

  end() { if (this.pending || this.overflow) this.flush(); }

  private flush() {
    const line = this.pending.replace(/\r$/, "");
    const begins = /-----BEGIN[ A-Z]*PRIVATE KEY-----/.test(line);
    const ends = /-----END[ A-Z]*PRIVATE KEY-----/.test(line);
    if (begins) this.privateKey = true;
    if (this.privateKey) {
      if (begins) this.emit(REDACTED);
      if (ends) this.privateKey = false;
    } else if (this.overflow) this.emit("[diagnostic omitted: size limit]");
    else if (line) this.emit(this.redactor.text(line));
    this.pending = "";
    this.overflow = false;
  }
}

const DIAGNOSTIC_EVENTS = new Set(["stderr", "turnError", "gapError", "approvalError", "agentExit", "hostExit", "bridgeExit", "connectionError", "loginError"]);
export function diagnosticEvent(event: string, payload: unknown): unknown {
  if (DIAGNOSTIC_EVENTS.has(event)) return diagnostics.value(payload);
  // Completion receipts may contain a nested failure alongside control fields.
  if (event === "turnCompleted" && payload && typeof payload === "object" && "outcome" in payload) {
    const record = payload as Record<string, unknown>;
    return { ...record, outcome: diagnostics.value(record.outcome) };
  }
  return payload;
}
