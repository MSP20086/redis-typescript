type Parsed<T> = { value: T; offset: number } | null;

const CR = 13;
const LF = 10;

function readLength(
  buffer: Buffer,
  offset: number,
  prefix: string,
): Parsed<number> {
  if (offset >= buffer.length) {
    return null;
  }
  if (buffer[offset] !== prefix.charCodeAt(0)) {
    throw new Error(`Expected '${prefix}' at offset ${offset}`);
  }
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd === -1) {
    return null;
  }
  const text = buffer.toString("latin1", offset + 1, lineEnd);
  const length = Number(text);
  if (!/^\d+$/.test(text) || !Number.isSafeInteger(length)) {
    throw new Error(`Invalid length '${text}' at offset ${offset}`);
  }
  return { value: length, offset: lineEnd + 2 };
}

function readBulkString(buffer: Buffer, offset: number): Parsed<Buffer> {
  const header = readLength(buffer, offset, "$");
  if (header === null) {
    return null;
  }
  const start = header.offset;
  const end = start + header.value;
  if (end + 2 > buffer.length) {
    return null;
  }
  if (buffer[end] !== CR || buffer[end + 1] !== LF) {
    throw new Error(`Missing CRLF after bulk string at offset ${end}`);
  }
  return { value: buffer.subarray(start, end), offset: end + 2 };
}

export function parseCommand(
  buffer: Buffer,
  offset: number,
): { args: Buffer[]; offset: number } | null {
  const header = readLength(buffer, offset, "*");
  if (header === null) {
    return null;
  }
  const args: Buffer[] = [];
  let position = header.offset;
  for (let i = 0; i < header.value; i++) {
    const arg = readBulkString(buffer, position);
    if (arg === null) {
      return null;
    }
    args.push(arg.value);
    position = arg.offset;
  }
  return { args, offset: position };
}

export function parseSimpleString(
  buffer: Buffer,
  offset: number,
): Parsed<string> {
  if (offset >= buffer.length) {
    return null;
  }
  if (buffer[offset] !== "+".charCodeAt(0)) {
    throw new Error(`Expected '+' at offset ${offset}`);
  }
  const lineEnd = buffer.indexOf("\r\n", offset);
  if (lineEnd === -1) {
    return null;
  }
  const value = buffer.toString("latin1", offset + 1, lineEnd);
  return { value, offset: lineEnd + 2 };
}

export function parseRdbTransfer(
  buffer: Buffer,
  offset: number,
): Parsed<Buffer> {
  const header = readLength(buffer, offset, "$");
  if (header === null) {
    return null;
  }
  const end = header.offset + header.value;
  if (end > buffer.length) {
    return null;
  }
  return { value: buffer.subarray(header.offset, end), offset: end };
}
