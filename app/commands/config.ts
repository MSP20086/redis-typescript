import type { ServerConfig } from "../config";
import { globToRegExp } from "../glob";
import { bulkArray, error, wrongArgs } from "../resp/encoder";
import type { CommandHandler } from "../types";

const parameters: Record<string, (config: ServerConfig) => string> = {
  dir: (config) => config.dir,
  dbfilename: (config) => config.dbfilename ?? "",
  appendonly: (config) => (config.appendonly ? "yes" : "no"),
  appenddirname: (config) => config.appenddirname,
  appendfilename: (config) => config.appendfilename,
  appendfsync: (config) => config.appendfsync,
};

export const config: CommandHandler = (args, { state }) => {
  if (args.length === 0) {
    return wrongArgs("config");
  }
  const subcommand = args[0].toString().toUpperCase();
  if (subcommand !== "GET") {
    return error(`ERR unknown subcommand '${subcommand}'. Try CONFIG HELP.`);
  }
  if (args.length < 2) {
    return wrongArgs("config|get");
  }
  const patterns = args
    .slice(1)
    .map((arg) => globToRegExp(arg.toString(), "i"));
  const reply: string[] = [];
  for (const [name, read] of Object.entries(parameters)) {
    if (patterns.some((pattern) => pattern.test(name))) {
      reply.push(name, read(state.config));
    }
  }
  return bulkArray(reply);
};
