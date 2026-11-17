import { bulkString } from "../resp/encoder";
import type { CommandHandler, RedisState } from "../types";

const sections: Record<string, (state: RedisState) => string[]> = {
  replication: ({ replication }) => [
    "# Replication",
    `role:${replication.role}`,
    `master_replid:${replication.replid}`,
    `master_repl_offset:${replication.offset}`,
  ],
};

const ALL_SECTIONS = new Set(["all", "default", "everything"]);

export const info: CommandHandler = (args, { state }) => {
  const requested = args.map((arg) => arg.toString().toLowerCase());
  const showAll =
    requested.length === 0 || requested.some((name) => ALL_SECTIONS.has(name));
  const lines = Object.entries(sections)
    .filter(([name]) => showAll || requested.includes(name))
    .flatMap(([, render]) => [...render(state), ""]);
  return bulkString(lines.join("\r\n"));
};
