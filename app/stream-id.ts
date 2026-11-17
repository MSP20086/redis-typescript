import type { StreamId } from "./types";

export const MAX_SEQ = (1n << 64n) - 1n;
export const MIN_ID: StreamId = { ms: 0n, seq: 0n };
export const MAX_ID: StreamId = { ms: MAX_SEQ, seq: MAX_SEQ };

export function parseUint(text: string): bigint | null {
  return /^\d+$/.test(text) ? BigInt(text) : null;
}

export function parseId(text: string, defaultSeq?: bigint): StreamId | null {
  const [msText, seqText, ...rest] = text.split("-");
  if (rest.length > 0) {
    return null;
  }
  const ms = parseUint(msText);
  const seq = seqText === undefined ? defaultSeq : parseUint(seqText);
  if (ms === null || seq === null || seq === undefined) {
    return null;
  }
  return { ms, seq };
}

export function compareIds(a: StreamId, b: StreamId): number {
  if (a.ms !== b.ms) {
    return a.ms < b.ms ? -1 : 1;
  }
  if (a.seq !== b.seq) {
    return a.seq < b.seq ? -1 : 1;
  }
  return 0;
}

export function formatId(id: StreamId): string {
  return `${id.ms}-${id.seq}`;
}
