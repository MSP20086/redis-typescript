import type { Socket } from "net";
import { cancelWaitersFor } from "./blocking";
import { executeCommand } from "./commands";
import { unsubscribeAll } from "./pubsub";
import { error } from "./resp/encoder";
import { parseCommand } from "./resp/parser";
import type { ClientState, RedisState } from "./types";
import { unwatchAll } from "./watch";

type ConnectionOptions = {
  fromMaster?: boolean;
  initialData?: Buffer;
};

export function createClientState(): ClientState {
  return {
    queued: null,
    watching: new Set(),
    dirty: false,
    subscriptions: new Set(),
  };
}

export function handleConnection(
  connection: Socket,
  state: RedisState,
  { fromMaster = false, initialData }: ConnectionOptions = {},
): void {
  let pending: Buffer = Buffer.alloc(0);
  let chain: Promise<void> = Promise.resolve();
  const client = createClientState();

  function shouldReply(args: Buffer[], response: Buffer): boolean {
    if (response.length === 0) {
      return false;
    }
    return !fromMaster || args[0]?.toString().toUpperCase() === "REPLCONF";
  }

  async function processPending(): Promise<void> {
    let offset = 0;
    while (offset < pending.length) {
      const parsed = parseCommand(pending, offset);
      if (parsed === null) {
        break;
      }
      const response = await executeCommand(parsed.args, {
        state,
        connection,
        client,
        canBlock: !fromMaster,
      }).catch((err) => {
        console.error("Error executing command:", err);
        return error("ERR internal server error");
      });
      if (connection.destroyed) {
        return;
      }
      if (fromMaster) {
        state.replication.offset += parsed.offset - offset;
      }
      if (shouldReply(parsed.args, response)) {
        connection.write(response);
      }
      offset = parsed.offset;
    }
    pending = pending.subarray(offset);
  }

  function receive(data: Buffer): void {
    chain = chain
      .then(() => {
        if (connection.writableEnded) {
          return;
        }
        pending = Buffer.concat([pending, data]);
        return processPending();
      })
      .catch((err) => {
        console.error("Protocol error:", err);
        connection.end(error("ERR Protocol error"));
      });
  }

  connection.on("data", receive);
  if (initialData !== undefined && initialData.length > 0) {
    receive(initialData);
  }
  connection.on("error", (err) =>
    console.error("Connection error:", err.message),
  );
  connection.on("close", () => {
    state.replication.replicas.delete(connection);
    unsubscribeAll(state, client, connection);
    cancelWaitersFor(connection, state.waitingClients);
    unwatchAll(state, client);
  });
}
