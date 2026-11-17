import type { Socket } from "net";
import { array, bulkString } from "./resp/encoder";
import type { ClientState, RedisState } from "./types";

export function subscribeChannel(
  state: RedisState,
  client: ClientState,
  connection: Socket,
  channel: string,
): void {
  client.subscriptions.add(channel);
  const subscribers = state.channels.get(channel) ?? new Set();
  subscribers.add(connection);
  state.channels.set(channel, subscribers);
}

export function unsubscribeChannel(
  state: RedisState,
  client: ClientState,
  connection: Socket,
  channel: string,
): void {
  client.subscriptions.delete(channel);
  const subscribers = state.channels.get(channel);
  subscribers?.delete(connection);
  if (subscribers?.size === 0) {
    state.channels.delete(channel);
  }
}

export function unsubscribeAll(
  state: RedisState,
  client: ClientState,
  connection: Socket,
): void {
  for (const channel of [...client.subscriptions]) {
    unsubscribeChannel(state, client, connection, channel);
  }
}

export function publishMessage(
  state: RedisState,
  channel: string,
  message: Buffer,
): number {
  const subscribers = state.channels.get(channel);
  if (subscribers === undefined) {
    return 0;
  }
  const push = array([
    bulkString("message"),
    bulkString(channel),
    bulkString(message),
  ]);
  for (const subscriber of subscribers) {
    subscriber.write(push);
  }
  return subscribers.size;
}
