const CRLF = Buffer.from("\r\n");

export function simpleString(value: string): Buffer {
  return Buffer.from(`+${value}\r\n`);
}

export function error(message: string): Buffer {
  return Buffer.from(`-${message}\r\n`);
}

export function integer(value: number | bigint): Buffer {
  return Buffer.from(`:${value}\r\n`);
}

export function bulkString(value: Buffer | string): Buffer {
  const data = typeof value === "string" ? Buffer.from(value) : value;
  return Buffer.concat([Buffer.from(`$${data.length}\r\n`), data, CRLF]);
}

export function array(items: Buffer[]): Buffer {
  return Buffer.concat([Buffer.from(`*${items.length}\r\n`), ...items]);
}

export function bulkArray(items: (Buffer | string)[]): Buffer {
  return array(items.map(bulkString));
}

export function isError(reply: Buffer): boolean {
  return reply[0] === 0x2d;
}

export function wrongArgs(command: string): Buffer {
  return error(`ERR wrong number of arguments for '${command}' command`);
}

export const OK = simpleString("OK");
export const PONG = simpleString("PONG");
export const QUEUED = simpleString("QUEUED");
export const NULL_BULK_STRING = Buffer.from("$-1\r\n");
export const NULL_ARRAY = Buffer.from("*-1\r\n");
export const EMPTY_ARRAY = array([]);
export const NO_REPLY = Buffer.alloc(0);
