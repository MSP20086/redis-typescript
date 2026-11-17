import { globToRegExp } from "../glob";
import { bulkArray, simpleString, wrongArgs } from "../resp/encoder";
import { getEntry } from "../store";
import type { CommandHandler } from "../types";

export const type: CommandHandler = (args, { state }) => {
  if (args.length !== 1) {
    return wrongArgs("type");
  }
  return simpleString(
    getEntry(state.storage, args[0].toString())?.type ?? "none",
  );
};

export const keys: CommandHandler = (args, { state }) => {
  if (args.length !== 1) {
    return wrongArgs("keys");
  }
  const pattern = globToRegExp(args[0].toString());
  const matching = [...state.storage.keys()].filter(
    (key) => pattern.test(key) && getEntry(state.storage, key) !== undefined,
  );
  return bulkArray(matching);
};
