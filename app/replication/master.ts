import type { Socket } from "net";
import { bulkArray, integer, simpleString } from "../resp/encoder";
import type { RedisState, ReplicationState } from "../types";

const EMPTY_RDB = Buffer.from(
  "524544495330303131fa0972656469732d76657205372e322e30fa0a72656469732d62697473c040fa056374696d65c26d08bc65fa08757365642d6d656dc2b0c41000fa08616f662d62617365c000fff06e3bfec0ff5aa2",
  "hex",
);

export function sendToReplicas(
  state: RedisState,
  command: (Buffer | string)[],
): void {
  const { replication } = state;
  if (replication.role !== "master" || replication.replicas.size === 0) {
    return;
  }
  const encoded = bulkArray(command);
  for (const replica of replication.replicas.keys()) {
    replica.write(encoded);
  }
  replication.offset += encoded.length;
}

export function addReplica(state: RedisState, connection: Socket): void {
  const { replication } = state;
  connection.write(
    Buffer.concat([
      simpleString(`FULLRESYNC ${replication.replid} ${replication.offset}`),
      Buffer.from(`$${EMPTY_RDB.length}\r\n`),
      EMPTY_RDB,
    ]),
  );
  replication.replicas.set(connection, replication.offset);
}

function countAcked(replication: ReplicationState, offset: number): number {
  let count = 0;
  for (const acked of replication.replicas.values()) {
    if (acked >= offset) {
      count++;
    }
  }
  return count;
}

export function recordAck(
  state: RedisState,
  connection: Socket,
  offset: number,
): void {
  const { replication } = state;
  if (!replication.replicas.has(connection)) {
    return;
  }
  replication.replicas.set(connection, offset);
  replication.ackWaiters = replication.ackWaiters.filter((waiter) => {
    const count = countAcked(replication, waiter.target);
    if (count < waiter.needed) {
      return true;
    }
    if (waiter.timer !== null) {
      clearTimeout(waiter.timer);
    }
    waiter.resolve(integer(count));
    return false;
  });
}

export function waitForReplicas(
  state: RedisState,
  needed: number,
  timeoutMs: number,
): Buffer | Promise<Buffer> {
  const { replication } = state;
  const target = replication.offset;
  const acked = countAcked(replication, target);
  if (acked >= needed || acked === replication.replicas.size) {
    return integer(acked);
  }
  sendToReplicas(state, ["REPLCONF", "GETACK", "*"]);
  return new Promise((resolve) => {
    const waiter = {
      target,
      needed,
      resolve,
      timer: null as NodeJS.Timeout | null,
    };
    if (timeoutMs > 0) {
      waiter.timer = setTimeout(() => {
        replication.ackWaiters = replication.ackWaiters.filter(
          (w) => w !== waiter,
        );
        resolve(integer(countAcked(replication, target)));
      }, timeoutMs);
    }
    replication.ackWaiters.push(waiter);
  });
}
