import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Client,
  connect,
  eventually,
  type ServerHandle,
  startServer,
} from "../helpers";

let master: ServerHandle;
let replicas: ServerHandle[] = [];
let client: Client;

beforeAll(async () => {
  master = await startServer();
  client = await connect(master.port);
  await client.call("SET", "seed", "before-sync");
  replicas = await Promise.all(
    [0, 1].map(() =>
      startServer(["--replicaof", `127.0.0.1 ${master.port}`]),
    ),
  );
  // Wait for both replicas to finish the handshake.
  await eventually(async () => (await client.call("WAIT", 2, 100)) === 2);
});

afterAll(async () => {
  client.close();
  await Promise.all(replicas.map((r) => r.stop()));
  await master.stop();
});

async function readFrom(server: ServerHandle, ...args: string[]) {
  const c = await connect(server.port);
  const reply = await c.call(...args);
  c.close();
  return reply;
}

describe("replication", () => {
  test("INFO reports master and slave roles", async () => {
    expect(await readFrom(master, "INFO", "replication")).toContain(
      "role:master",
    );
    expect(await readFrom(replicas[0], "INFO", "replication")).toContain(
      "role:slave",
    );
  });

  test("writes are propagated to every replica", async () => {
    await client.call("SET", "fruit", "mango");
    await client.call("INCR", "hits");
    await client.call("RPUSH", "jobs", "a", "b");
    await client.call("XADD", "log", "1-1", "event", "start");

    for (const replica of replicas) {
      await eventually(
        async () => (await readFrom(replica, "GET", "fruit")) === "mango",
      );
      expect(await readFrom(replica, "GET", "hits")).toBe("1");
      expect(await readFrom(replica, "LRANGE", "jobs", "0", "-1")).toEqual([
        "a",
        "b",
      ]);
      expect(await readFrom(replica, "XRANGE", "log", "-", "+")).toEqual([
        ["1-1", ["event", "start"]],
      ]);
    }
  });

  test("WAIT returns once replicas acknowledge the latest offset", async () => {
    await client.call("SET", "durable", "yes");
    expect(await client.call("WAIT", 2, 1000)).toBe(2);
    for (const replica of replicas) {
      expect(await readFrom(replica, "GET", "durable")).toBe("yes");
    }
  });

  test("WAIT 0 returns immediately without blocking", async () => {
    const start = Date.now();
    const acked = (await client.call("WAIT", 0, 0)) as number;
    expect(acked).toBeGreaterThanOrEqual(0);
    expect(acked).toBeLessThanOrEqual(2);
    expect(Date.now() - start).toBeLessThan(100);
  });

  test("WAIT times out when more replicas are requested than exist", async () => {
    await client.call("SET", "another", "write");
    const start = Date.now();
    expect(await client.call("WAIT", 3, 200)).toBe(2);
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
  });

  test("BLPOP pops on the master are replicated as LPOP", async () => {
    const waiter = await connect(master.port);
    waiter.send("BLPOP", "tasks", 0);
    await Bun.sleep(50);
    await client.call("RPUSH", "tasks", "t1", "t2");
    expect(await waiter.next()).toEqual(["tasks", "t1"]);
    waiter.close();
    for (const replica of replicas) {
      await eventually(async () => {
        const list = await readFrom(replica, "LRANGE", "tasks", "0", "-1");
        return JSON.stringify(list) === JSON.stringify(["t2"]);
      });
    }
  });
});
