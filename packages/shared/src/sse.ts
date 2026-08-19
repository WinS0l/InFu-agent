/**
 * Incremental SSE framing for browser streams. It deliberately operates on
 * decoded text: callers keep one TextDecoder per response to preserve UTF-8
 * characters split across Uint8Array chunks.
 */
export function takeSseFrames(buffer: string): { frames: string[]; remainder: string } {
  const frames = buffer.split(/\r?\n\r?\n/);
  return { frames: frames.slice(0, -1), remainder: frames.at(-1) ?? "" };
}

/** Read an SSE event's data field, including standard multi-line data values. */
export function readSseData(frame: string): string | null {
  const lines = frame.split(/\r?\n/);
  const data = lines
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).replace(/^ /, ""));
  return data.length ? data.join("\n") : null;
}

export function readSseEventName(frame: string): string | null {
  const line = frame.split(/\r?\n/).find((part) => part.startsWith("event:"));
  return line ? line.slice(6).trim() : null;
}
