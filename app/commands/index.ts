import { serveBlockedClients } from "../blocking";
import { CommandError } from "../errors";
import { propagateWrite } from "../propagate";
import { error, isError, QUEUED } from "../resp/encoder";
import type { CommandContext, CommandHandler } from "../types";
import { copyAll } from "./args";
import { echo, ping } from "./basic";
import { config } from "./config";
import { info } from "./info";
import { keys, type } from "./keys";
import { blpop, llen, lpop, lpush, lrange, rpush } from "./lists";
import { psync, replconf, wait } from "./replication";
import { xadd, xrange, xread } from "./streams";
import { get, incr, set } from "./strings";
import { publish, subscribe, unsubscribe } from "./pubsub";
import { discard, exec, multi, unwatch, watch } from "./transaction";

const WRITE_COMMANDS = new Set([
  "SET",
  "INCR",
  "RPUSH",
  "LPUSH",
  "LPOP",
  "XADD",
]);

const SUBSCRIBED_MODE_COMMANDS = new Set([
  "SUBSCRIBE",
  "UNSUBSCRIBE",
  "PSUBSCRIBE",
  "PUNSUBSCRIBE",
  "PING",
  "QUIT",
  "RESET",
]);

const handlers = new Map<string, CommandHandler>([
  ["PING", ping],
  ["ECHO", echo],
  ["INFO", info],
  ["TYPE", type],
  ["GET", get],
  ["SET", set],
  ["INCR", incr],
  ["RPUSH", rpush],
  ["LPUSH", lpush],
  ["LRANGE", lrange],
  ["LLEN", llen],
  ["LPOP", lpop],
  ["BLPOP", blpop],
  ["XADD", xadd],
  ["XRANGE", xrange],
  ["XREAD", xread],
  ["UNWATCH", unwatch],
  ["REPLCONF", replconf],
  ["PSYNC", psync],
  ["WAIT", wait],
  ["CONFIG", config],
  ["KEYS", keys],
  ["SUBSCRIBE", subscribe],
  ["PUBLISH", publish],
  ["UNSUBSCRIBE", unsubscribe],
]);

async function runCommand(
  args: Buffer[],
  ctx: CommandContext,
): Promise<Buffer> {
  const name = args[0].toString().toUpperCase();
  const handler = handlers.get(name);
  if (handler === undefined) {
    return error(`ERR unknown command '${name}'`);
  }
  let reply: Buffer | Promise<Buffer>;
  try {
    reply = handler(args.slice(1), ctx);
  } catch (err) {
    if (!(err instanceof CommandError)) {
      throw err;
    }
    reply = error(err.message);
  }
  if (WRITE_COMMANDS.has(name) && reply instanceof Buffer && !isError(reply)) {
    propagateWrite(ctx.state, args);
  }
  serveBlockedClients(ctx.state);
  return reply;
}

export async function executeCommand(
  args: Buffer[],
  ctx: CommandContext,
): Promise<Buffer> {
  if (args.length === 0) {
    return error("ERR no command provided");
  }
  const name = args[0].toString().toUpperCase();
  const rest = args.slice(1);

  if (
    ctx.client.subscriptions.size > 0 &&
    !SUBSCRIBED_MODE_COMMANDS.has(name)
  ) {
    return error(
      `ERR Can't execute '${name}': only (P|S)SUBSCRIBE / (P|S)UNSUBSCRIBE / PING / QUIT / RESET are allowed in this context`,
    );
  }

  switch (name) {
    case "MULTI":
      return multi(rest, ctx);
    case "DISCARD":
      return discard(rest, ctx);
    case "WATCH":
      return watch(rest, ctx);
    case "EXEC":
      return exec(rest, ctx, (command) =>
        runCommand(command, { ...ctx, canBlock: false }),
      );
  }

  if (ctx.client.queued !== null) {
    ctx.client.queued.push(copyAll(args));
    return QUEUED;
  }
  return runCommand(args, ctx);
}
