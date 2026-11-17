import { WrongTypeError } from "./errors";
import type {
  ListValue,
  Storage,
  StoredValue,
  StreamEntry,
  StreamValue,
  StringValue,
} from "./types";

export function getEntry(
  storage: Storage,
  key: string,
): StoredValue | undefined {
  const entry = storage.get(key);
  if (
    entry !== undefined &&
    entry.expiresAt !== null &&
    entry.expiresAt <= Date.now()
  ) {
    storage.delete(key);
    return undefined;
  }
  return entry;
}

export function getString(
  storage: Storage,
  key: string,
): StringValue | undefined {
  const entry = getEntry(storage, key);
  if (entry !== undefined && entry.type !== "string") {
    throw new WrongTypeError();
  }
  return entry;
}

export function getList(storage: Storage, key: string): ListValue | undefined {
  const entry = getEntry(storage, key);
  if (entry !== undefined && entry.type !== "list") {
    throw new WrongTypeError();
  }
  return entry;
}

export function getStream(
  storage: Storage,
  key: string,
): StreamValue | undefined {
  const entry = getEntry(storage, key);
  if (entry !== undefined && entry.type !== "stream") {
    throw new WrongTypeError();
  }
  return entry;
}

export function createList(values: Buffer[]): ListValue {
  return { type: "list", value: values, expiresAt: null };
}

export function createStream(entries: StreamEntry[]): StreamValue {
  return { type: "stream", value: entries, expiresAt: null };
}
