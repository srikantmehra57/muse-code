/** Byte ceilings include JSON escaping, but exclude the newline delimiter. */
export const MAX_FRAME_BYTES = 64 * 1024 * 1024;

/** Incremental UTF-8 NDJSON reader. Never retain more than one bounded frame. */
export class LineFrames {
  private buffer = Buffer.alloc(0);
  private size = 0;
  private failed = false;

  constructor(private readonly limit = MAX_FRAME_BYTES) {}

  push(chunk: Buffer, onLine: (line: string) => void) {
    if (this.failed) throw new Error("Protocol reader is closed.");
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline < 0 ? chunk.length : newline;
      const length = end - offset;
      if (this.size + length > this.limit) {
        this.failed = true;
        this.buffer = Buffer.alloc(0);
        this.size = 0;
        throw new Error("Protocol frame exceeds the byte limit.");
      }
      if (this.size + length > this.buffer.length) {
        const grown = Buffer.allocUnsafe(Math.min(this.limit, Math.max(this.size + length, this.buffer.length * 2, 4096)));
        this.buffer.copy(grown, 0, 0, this.size);
        this.buffer = grown;
      }
      chunk.copy(this.buffer, this.size, offset, end);
      this.size += length;
      if (newline < 0) return;
      const line = this.buffer.toString("utf8", 0, this.size);
      this.buffer = Buffer.alloc(0);
      this.size = 0;
      onLine(line);
      offset = newline + 1;
    }
  }
}

export function encodeFrame(value: unknown): string {
  const line = JSON.stringify(value);
  if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) {
    throw new Error("Protocol frame exceeds the byte limit.");
  }
  return `${line}\n`;
}
