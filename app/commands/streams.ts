import { blockOnKeys, signalKeyReady } from "../blocking";
import { CommandError } from "../errors";
import {
  array,
  bulkArray,
  bulkString,
  error,
  NULL_ARRAY,
  wrongArgs,
} from "../resp/encoder";
import { createStream, getStream } from "../store";
import {
  compareIds,
  formatId,
  MAX_ID,
  MAX_SEQ,
  MIN_ID,
  parseId,
  parseUint,
} from "../stream-id";
import type { CommandHandler, Storage, StreamEntry, StreamId } from "../types";
import { touchKey } from "../watch";
import { copyAll } from "./args";

const INVALID_ID = "ERR Invalid stream ID specified as stream command argument";
const ID_NOT_POSITIVE = "ERR The ID specified in XADD must be greater than 0-0";
const ID_TOO_SMALL =
  "ERR The ID specified in XADD is equal or smaller than the target stream top item";

function encodeEntry(entry: StreamEntry): Buffer {
  return array([bulkString(formatId(entry.id)), bulkArray(entry.fields)]);
}

function resolveNewId(spec: string, last: StreamId | undefined): StreamId {
  if (spec === "*") {
    const now = BigInt(Date.now());
    return last !== undefined && last.ms >= now
      ? { ms: last.ms, seq: last.seq + 1n }
      : { ms: now, seq: 0n };
  }

  if (spec.endsWith("-*")) {
    const ms = parseUint(spec.slice(0, -2));
    if (ms === null) {
      throw new CommandError(INVALID_ID);
    }
    if (last !== undefined && ms < last.ms) {
      throw new CommandError(ID_TOO_SMALL);
    }
    if (last !== undefined && ms === last.ms) {
      return { ms, seq: last.seq + 1n };
    }
    return { ms, seq: ms === 0n ? 1n : 0n };
  }

  const id = parseId(spec);
  if (id === null) {
    throw new CommandError(INVALID_ID);
  }
  if (compareIds(id, MIN_ID) <= 0) {
    throw new CommandError(ID_NOT_POSITIVE);
  }
  if (last !== undefined && compareIds(id, last) <= 0) {
    throw new CommandError(ID_TOO_SMALL);
  }
  return id;
}

function parseRangeBound(text: string, isStart: boolean): StreamId {
  if (text === "-") {
    return MIN_ID;
  }
  if (text === "+") {
    return MAX_ID;
  }
  const id = parseId(text, isStart ? 0n : MAX_SEQ);
  if (id === null) {
    throw new CommandError(INVALID_ID);
  }
  return id;
}

function resolveReadId(storage: Storage, key: string, spec: string): StreamId {
  if (spec === "$") {
    return getStream(storage, key)?.value.at(-1)?.id ?? MIN_ID;
  }
  const id = parseId(spec, 0n);
  if (id === null) {
    throw new CommandError(INVALID_ID);
  }
  return id;
}

function readAfter(
  storage: Storage,
  key: string,
  afterId: StreamId,
): Buffer | null {
  const entries = getStream(storage, key)?.value ?? [];
  const newer = entries.filter((e) => compareIds(e.id, afterId) > 0);
  if (newer.length === 0) {
    return null;
  }
  return array([bulkString(key), array(newer.map(encodeEntry))]);
}

export const xadd: CommandHandler = (args, { state }) => {
  if (args.length < 4 || args.length % 2 !== 0) {
    return wrongArgs("xadd");
  }
  const key = args[0].toString();
  const stream = getStream(state.storage, key);
  const id = resolveNewId(args[1].toString(), stream?.value.at(-1)?.id);
  const entry: StreamEntry = { id, fields: copyAll(args.slice(2)) };

  if (stream === undefined) {
    state.storage.set(key, createStream([entry]));
  } else {
    stream.value.push(entry);
  }
  touchKey(state, key);
  signalKeyReady(state, key);
  return bulkString(formatId(id));
};

export const xrange: CommandHandler = (args, { state }) => {
  if (args.length !== 3) {
    return wrongArgs("xrange");
  }
  const start = parseRangeBound(args[1].toString(), true);
  const end = parseRangeBound(args[2].toString(), false);
  const entries = getStream(state.storage, args[0].toString())?.value ?? [];
  const inRange = entries.filter(
    (e) => compareIds(e.id, start) >= 0 && compareIds(e.id, end) <= 0,
  );
  return array(inRange.map(encodeEntry));
};

export const xread: CommandHandler = (
  args,
  { state, connection, canBlock },
) => {
  const hasBlock = args[0]?.toString().toUpperCase() === "BLOCK";
  const streamsAt = hasBlock ? 2 : 0;
  const streamArgs = args.slice(streamsAt + 1);
  if (
    args[streamsAt]?.toString().toUpperCase() !== "STREAMS" ||
    streamArgs.length === 0 ||
    streamArgs.length % 2 !== 0
  ) {
    return wrongArgs("xread");
  }

  let blockMs: number | null = null;
  if (hasBlock) {
    blockMs = Number(args[1].toString());
    if (!Number.isSafeInteger(blockMs) || blockMs < 0) {
      return error("ERR timeout must be a non-negative integer");
    }
  }

  const count = streamArgs.length / 2;
  const keys = streamArgs.slice(0, count).map((arg) => arg.toString());
  const afterIds = keys.map((key, i) =>
    resolveReadId(state.storage, key, streamArgs[count + i].toString()),
  );

  const results = keys
    .map((key, i) => readAfter(state.storage, key, afterIds[i]))
    .filter((result) => result !== null);
  if (results.length > 0 || blockMs === null) {
    return array(results);
  }
  if (!canBlock) {
    return NULL_ARRAY;
  }

  return blockOnKeys(state.waitingClients, connection, keys, blockMs, (key) => {
    const result = readAfter(state.storage, key, afterIds[keys.indexOf(key)]);
    return result === null ? null : array([result]);
  });
};
