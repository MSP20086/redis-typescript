import { appendToAof } from "./aof";
import { sendToReplicas } from "./replication/master";
import type { RedisState } from "./types";

export function propagateWrite(
  state: RedisState,
  command: (Buffer | string)[],
): void {
  appendToAof(state, command);
  sendToReplicas(state, command);
}
