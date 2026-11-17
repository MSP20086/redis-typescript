import { blockOnKeys, signalKeyReady } from "../blocking";
import {
  bulkArray,
  bulkString,
  EMPTY_ARRAY,
  error,
  integer,
  NULL_ARRAY,
  NULL_BULK_STRING,
  wrongArgs,
} from "../resp/encoder";
import { propagateWrite } from "../propagate";
import { createList, getList } from "../store";
import type { CommandHandler, RedisState } from "../types";
import { touchKey } from "../watch";
import { copyAll } from "./args";

function push(
  args: Buffer[],
  state: RedisState,
  command: string,
  atHead: boolean,
): Buffer {
  if (args.length < 2) {
    return wrongArgs(command);
  }
  const key = args[0].toString();
  const values = copyAll(args.slice(1));
  let list = getList(state.storage, key);
  if (list === undefined) {
    list = createList([]);
    state.storage.set(key, list);
  }
  if (atHead) {
    list.value.unshift(...values.reverse());
  } else {
    list.value.push(...values);
  }
  const length = list.value.length;
  touchKey(state, key);
  signalKeyReady(state, key);
  return integer(length);
}

function popFront(state: RedisState, key: string, count: number): Buffer[] {
  const list = getList(state.storage, key);
  const popped = list?.value.splice(0, count) ?? [];
  if (list !== undefined && list.value.length === 0) {
    state.storage.delete(key);
  }
  if (popped.length > 0) {
    touchKey(state, key);
  }
  return popped;
}

export const rpush: CommandHandler = (args, { state }) =>
  push(args, state, "rpush", false);

export const lpush: CommandHandler = (args, { state }) =>
  push(args, state, "lpush", true);

export const lrange: CommandHandler = (args, { state }) => {
  if (args.length !== 3) {
    return wrongArgs("lrange");
  }
  const start = Number(args[1].toString());
  const stop = Number(args[2].toString());
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(stop)) {
    return error("ERR start and stop must be integers");
  }
  const list = getList(state.storage, args[0].toString());
  if (list === undefined) {
    return EMPTY_ARRAY;
  }
  const length = list.value.length;
  const from = Math.max(start < 0 ? start + length : start, 0);
  const to = Math.min(stop < 0 ? stop + length : stop, length - 1);
  if (from > to) {
    return EMPTY_ARRAY;
  }
  return bulkArray(list.value.slice(from, to + 1));
};

export const llen: CommandHandler = (args, { state }) => {
  if (args.length !== 1) {
    return wrongArgs("llen");
  }
  const list = getList(state.storage, args[0].toString());
  return integer(list?.value.length ?? 0);
};

export const lpop: CommandHandler = (args, { state }) => {
  if (args.length < 1 || args.length > 2) {
    return wrongArgs("lpop");
  }
  const key = args[0].toString();
  const withCount = args.length === 2;
  const count = withCount ? Number(args[1].toString()) : 1;
  if (!Number.isSafeInteger(count) || count < 0) {
    return error("ERR count must be a non-negative integer");
  }
  const popped = popFront(state, key, count);
  if (withCount) {
    return bulkArray(popped);
  }
  return popped.length > 0 ? bulkString(popped[0]) : NULL_BULK_STRING;
};

export const blpop: CommandHandler = (
  args,
  { state, connection, canBlock },
) => {
  if (args.length < 2) {
    return wrongArgs("blpop");
  }
  const keys = args.slice(0, -1).map((arg) => arg.toString());
  const timeoutSeconds = Number(args[args.length - 1].toString());
  if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
    return error("ERR timeout must be a non-negative integer");
  }
  const serve = (key: string) => {
    const [value] = popFront(state, key, 1);
    if (value === undefined) {
      return null;
    }
    propagateWrite(state, ["LPOP", key]);
    return bulkArray([key, value]);
  };
  for (const key of keys) {
    const response = serve(key);
    if (response !== null) {
      return response;
    }
  }
  if (!canBlock) {
    return NULL_ARRAY;
  }
  return blockOnKeys(
    state.waitingClients,
    connection,
    keys,
    timeoutSeconds * 1000,
    serve,
  );
};
