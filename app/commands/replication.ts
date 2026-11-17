import { addReplica, recordAck, waitForReplicas } from "../replication/master";
import { bulkArray, error, NO_REPLY, OK, wrongArgs } from "../resp/encoder";
import type { CommandHandler } from "../types";

function parseNonNegativeInt(arg: Buffer): number | null {
  const value = Number(arg.toString());
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export const replconf: CommandHandler = (args, { state, connection }) => {
  if (args.length < 2) {
    return wrongArgs("replconf");
  }
  switch (args[0].toString().toUpperCase()) {
    case "ACK": {
      const offset = parseNonNegativeInt(args[1]);
      if (offset !== null) {
        recordAck(state, connection, offset);
      }
      return NO_REPLY;
    }
    case "GETACK":
      return bulkArray(["REPLCONF", "ACK", String(state.replication.offset)]);
    default:
      return OK;
  }
};

export const psync: CommandHandler = (_args, { state, connection }) => {
  addReplica(state, connection);
  return NO_REPLY;
};

export const wait: CommandHandler = (args, { state }) => {
  if (args.length !== 2) {
    return wrongArgs("wait");
  }
  const needed = parseNonNegativeInt(args[0]);
  const timeoutMs = parseNonNegativeInt(args[1]);
  if (needed === null || timeoutMs === null) {
    return error("ERR value is not an integer or out of range");
  }
  return waitForReplicas(state, needed, timeoutMs);
};
