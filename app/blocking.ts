import type { Socket } from "net";
import { WrongTypeError } from "./errors";
import { NO_REPLY, NULL_ARRAY } from "./resp/encoder";
import type { RedisState, WaitingClient, WaitingClients } from "./types";

function removeWaiter(
  waiter: WaitingClient,
  waitingClients: WaitingClients,
): void {
  for (const key of waiter.keys) {
    const queue = waitingClients.get(key);
    if (queue === undefined) {
      continue;
    }
    const remaining = queue.filter((w) => w !== waiter);
    if (remaining.length === 0) {
      waitingClients.delete(key);
    } else {
      waitingClients.set(key, remaining);
    }
  }
}

function settle(
  waiter: WaitingClient,
  waitingClients: WaitingClients,
  response: Buffer,
): void {
  if (waiter.timer !== null) {
    clearTimeout(waiter.timer);
  }
  removeWaiter(waiter, waitingClients);
  waiter.resolve(response);
}

export function blockOnKeys(
  waitingClients: WaitingClients,
  connection: Socket,
  keys: string[],
  timeoutMs: number,
  serve: (key: string) => Buffer | null,
): Promise<Buffer> {
  return new Promise((resolve) => {
    const waiter: WaitingClient = {
      connection,
      keys,
      serve,
      resolve,
      timer: null,
    };
    for (const key of keys) {
      const queue = waitingClients.get(key) ?? [];
      queue.push(waiter);
      waitingClients.set(key, queue);
    }
    if (timeoutMs > 0) {
      waiter.timer = setTimeout(
        () => settle(waiter, waitingClients, NULL_ARRAY),
        timeoutMs,
      );
    }
  });
}

export function signalKeyReady(state: RedisState, key: string): void {
  state.readyKeys.add(key);
}

export function serveBlockedClients(state: RedisState): void {
  for (const key of state.readyKeys) {
    state.readyKeys.delete(key);
    wakeWaiters(state.waitingClients, key);
  }
}

function wakeWaiters(waitingClients: WaitingClients, key: string): void {
  for (const waiter of new Set(waitingClients.get(key))) {
    let response: Buffer | null;
    try {
      response = waiter.serve(key);
    } catch (err) {
      if (err instanceof WrongTypeError) {
        continue;
      }
      throw err;
    }
    if (response !== null) {
      settle(waiter, waitingClients, response);
    }
  }
}

export function cancelWaitersFor(
  connection: Socket,
  waitingClients: WaitingClients,
): void {
  const waiters = new Set<WaitingClient>();
  for (const queue of waitingClients.values()) {
    for (const waiter of queue) {
      if (waiter.connection === connection) {
        waiters.add(waiter);
      }
    }
  }
  for (const waiter of waiters) {
    settle(waiter, waitingClients, NO_REPLY);
  }
}
