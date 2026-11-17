import {
  bulkString,
  error,
  integer,
  NULL_BULK_STRING,
  OK,
  wrongArgs,
} from "../resp/encoder";
import { getString } from "../store";
import type { CommandHandler } from "../types";
import { touchKey } from "../watch";

export const set: CommandHandler = (args, { state }) => {
  if (args.length !== 2 && args.length !== 4) {
    return wrongArgs("set");
  }
  const [key, value, option, ttl] = args;
  let expiresAt: number | null = null;
  if (option !== undefined) {
    if (option.toString().toUpperCase() !== "PX") {
      return error("ERR syntax error");
    }
    const ms = Number(ttl.toString());
    if (!Number.isSafeInteger(ms) || ms <= 0) {
      return error("ERR invalid expiration time in set");
    }
    expiresAt = Date.now() + ms;
  }
  state.storage.set(key.toString(), {
    type: "string",
    value: Buffer.from(value),
    expiresAt,
  });
  touchKey(state, key.toString());
  return OK;
};

export const get: CommandHandler = (args, { state }) => {
  if (args.length !== 1) {
    return wrongArgs("get");
  }
  const entry = getString(state.storage, args[0].toString());
  return entry === undefined ? NULL_BULK_STRING : bulkString(entry.value);
};

const INT64_MIN = -(1n << 63n);
const INT64_MAX = (1n << 63n) - 1n;

function parseInt64(text: string): bigint | null {
  if (!/^-?\d+$/.test(text)) {
    return null;
  }
  const value = BigInt(text);
  return value >= INT64_MIN && value <= INT64_MAX ? value : null;
}

export const incr: CommandHandler = (args, { state }) => {
  if (args.length !== 1) {
    return wrongArgs("incr");
  }
  const key = args[0].toString();
  const entry = getString(state.storage, key);
  const current = entry === undefined ? 0n : parseInt64(entry.value.toString());
  if (current === null || current === INT64_MAX) {
    return error("ERR value is not an integer or out of range");
  }
  const next = current + 1n;
  state.storage.set(key, {
    type: "string",
    value: Buffer.from(next.toString()),
    expiresAt: entry?.expiresAt ?? null,
  });
  touchKey(state, key);
  return integer(next);
};
