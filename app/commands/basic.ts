import { bulkArray, bulkString, PONG, wrongArgs } from "../resp/encoder";
import type { CommandHandler } from "../types";

export const ping: CommandHandler = (args, { client }) => {
  if (args.length > 1) {
    return wrongArgs("ping");
  }
  if (client.subscriptions.size > 0) {
    return bulkArray(["pong", args[0] ?? ""]);
  }
  return args.length === 0 ? PONG : bulkString(args[0]);
};

export const echo: CommandHandler = (args) => {
  if (args.length !== 1) {
    return wrongArgs("echo");
  }
  return bulkString(args[0]);
};
