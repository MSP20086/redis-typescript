import { array, error, NULL_ARRAY, OK, wrongArgs } from "../resp/encoder";
import type { CommandContext, CommandHandler } from "../types";
import { unwatchAll, watchKeys } from "../watch";

export function multi(args: Buffer[], { client }: CommandContext): Buffer {
  if (args.length !== 0) {
    return wrongArgs("multi");
  }
  if (client.queued !== null) {
    return error("ERR MULTI calls can not be nested");
  }
  client.queued = [];
  return OK;
}

export async function exec(
  args: Buffer[],
  { state, client }: CommandContext,
  run: (command: Buffer[]) => Promise<Buffer>,
): Promise<Buffer> {
  if (args.length !== 0) {
    return wrongArgs("exec");
  }
  const queued = client.queued;
  if (queued === null) {
    return error("ERR EXEC without MULTI");
  }
  const aborted = client.dirty;
  client.queued = null;
  unwatchAll(state, client);
  if (aborted) {
    return NULL_ARRAY;
  }
  const replies: Buffer[] = [];
  for (const command of queued) {
    replies.push(await run(command));
  }
  return array(replies);
}

export function discard(
  args: Buffer[],
  { state, client }: CommandContext,
): Buffer {
  if (args.length !== 0) {
    return wrongArgs("discard");
  }
  if (client.queued === null) {
    return error("ERR DISCARD without MULTI");
  }
  client.queued = null;
  unwatchAll(state, client);
  return OK;
}

export function watch(
  args: Buffer[],
  { state, client }: CommandContext,
): Buffer {
  if (args.length === 0) {
    return wrongArgs("watch");
  }
  if (client.queued !== null) {
    return error("ERR WATCH inside MULTI is not allowed");
  }
  watchKeys(
    state,
    client,
    args.map((arg) => arg.toString()),
  );
  return OK;
}

export const unwatch: CommandHandler = (args, { state, client }) => {
  if (args.length !== 0) {
    return wrongArgs("unwatch");
  }
  unwatchAll(state, client);
  return OK;
};
