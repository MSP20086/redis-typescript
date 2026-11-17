import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  type Client,
  connect,
  encodeCommand,
  RespError,
  type ServerHandle,
  startServer,
} from "../helpers";

let server: ServerHandle;
let client: Client;

beforeAll(async () => {
  server = await startServer();
  client = await connect(server.port);
});

afterAll(async () => {
  client.close();
  await server.stop();
});

describe("basics", () => {
  test("PING and ECHO", async () => {
    expect(await client.call("PING")).toBe("PONG");
    expect(await client.call("ECHO", "hello")).toBe("hello");
  });

  test("unknown commands and wrong arity return errors", async () => {
    expect(await client.call("NOPE")).toBeInstanceOf(RespError);
    expect(await client.call("GET")).toBeInstanceOf(RespError);
  });

  test("handles pipelined commands sent in a single write", async () => {
    client.sendRaw(
      Buffer.concat([
        encodeCommand(["SET", "pipe", "1"]),
        encodeCommand(["INCR", "pipe"]),
        encodeCommand(["GET", "pipe"]),
      ]),
    );
    expect(await client.next()).toBe("OK");
    expect(await client.next()).toBe(2);
    expect(await client.next()).toBe("2");
  });

  test("handles a command split across many TCP packets", async () => {
    const frame = encodeCommand(["ECHO", "fragmented"]);
    for (const byte of frame) {
      client.sendRaw(Buffer.from([byte]));
      await Bun.sleep(1);
    }
    expect(await client.next()).toBe("fragmented");
  });

  test("serves many concurrent clients", async () => {
    const clients = await Promise.all(
      Array.from({ length: 20 }, () => connect(server.port)),
    );
    await Promise.all(
      clients.map(async (c) => {
        for (let i = 0; i < 25; i++) await c.call("INCR", "shared-counter");
      }),
    );
    expect(await client.call("GET", "shared-counter")).toBe("500");
    clients.forEach((c) => c.close());
  });
});

describe("strings and keys", () => {
  test("SET / GET / INCR", async () => {
    expect(await client.call("SET", "greeting", "hello")).toBe("OK");
    expect(await client.call("GET", "greeting")).toBe("hello");
    expect(await client.call("GET", "missing")).toBeNull();
    expect(await client.call("INCR", "counter")).toBe(1);
    expect(await client.call("INCR", "counter")).toBe(2);
    expect(await client.call("INCR", "greeting")).toBeInstanceOf(RespError);
  });

  test("keys expire after PX milliseconds", async () => {
    await client.call("SET", "temp", "v", "PX", 100);
    expect(await client.call("GET", "temp")).toBe("v");
    await Bun.sleep(150);
    expect(await client.call("GET", "temp")).toBeNull();
  });

  test("TYPE and KEYS", async () => {
    await client.call("SET", "user:1", "a");
    await client.call("SET", "user:2", "b");
    await client.call("RPUSH", "user:list", "x");
    expect(await client.call("TYPE", "user:1")).toBe("string");
    expect(await client.call("TYPE", "user:list")).toBe("list");
    expect(await client.call("TYPE", "nothing")).toBe("none");
    const keys = (await client.call("KEYS", "user:?")) as string[];
    expect(keys.sort()).toEqual(["user:1", "user:2"]);
  });

  test("CONFIG GET and INFO", async () => {
    expect(await client.call("CONFIG", "GET", "appendfsync")).toEqual([
      "appendfsync",
      "everysec",
    ]);
    const info = (await client.call("INFO", "replication")) as string;
    expect(info).toContain("role:master");
  });
});

describe("lists", () => {
  test("RPUSH / LPUSH / LRANGE / LLEN / LPOP", async () => {
    expect(await client.call("RPUSH", "list", "b", "c")).toBe(2);
    expect(await client.call("LPUSH", "list", "a0", "a")).toBe(4);
    expect(await client.call("LRANGE", "list", 0, -1)).toEqual([
      "a",
      "a0",
      "b",
      "c",
    ]);
    expect(await client.call("LRANGE", "list", -2, 100)).toEqual(["b", "c"]);
    expect(await client.call("LLEN", "list")).toBe(4);
    expect(await client.call("LPOP", "list")).toBe("a");
    expect(await client.call("LPOP", "list", 2)).toEqual(["a0", "b"]);
  });

  test("BLPOP blocks until another client pushes", async () => {
    const waiter = await connect(server.port);
    waiter.send("BLPOP", "queue", 0);
    expect(await waiter.hasReplyWithin(100)).toBe(false);
    await client.call("RPUSH", "queue", "job-1");
    expect(await waiter.next()).toEqual(["queue", "job-1"]);
    waiter.close();
  });

  test("BLPOP serves waiting clients in FIFO order", async () => {
    const first = await connect(server.port);
    const second = await connect(server.port);
    first.send("BLPOP", "fifo", 0);
    await Bun.sleep(20);
    second.send("BLPOP", "fifo", 0);
    await Bun.sleep(20);
    await client.call("RPUSH", "fifo", "one", "two");
    expect(await first.next()).toEqual(["fifo", "one"]);
    expect(await second.next()).toEqual(["fifo", "two"]);
    first.close();
    second.close();
  });

  test("BLPOP times out with a null reply", async () => {
    const start = Date.now();
    expect(await client.call("BLPOP", "empty", 0.1)).toBeNull();
    expect(Date.now() - start).toBeGreaterThanOrEqual(90);
  });
});

describe("streams", () => {
  test("XADD validates and auto-generates IDs", async () => {
    expect(await client.call("XADD", "s", "1-1", "temp", "20")).toBe("1-1");
    expect(await client.call("XADD", "s", "1-*", "temp", "21")).toBe("1-2");
    expect(await client.call("XADD", "s", "1-1", "temp", "x")).toBeInstanceOf(
      RespError,
    );
    expect(await client.call("XADD", "s2", "0-0", "a", "b")).toBeInstanceOf(
      RespError,
    );
    const auto = (await client.call("XADD", "s", "*", "temp", "22")) as string;
    expect(auto).toMatch(/^\d+-\d+$/);
    expect(await client.call("TYPE", "s")).toBe("stream");
  });

  test("XRANGE returns entries in range", async () => {
    await client.call("XADD", "r", "1-0", "a", "1");
    await client.call("XADD", "r", "2-0", "b", "2");
    await client.call("XADD", "r", "3-0", "c", "3");
    expect(await client.call("XRANGE", "r", "2", "+")).toEqual([
      ["2-0", ["b", "2"]],
      ["3-0", ["c", "3"]],
    ]);
    expect(await client.call("XRANGE", "r", "-", "1")).toEqual([
      ["1-0", ["a", "1"]],
    ]);
  });

  test("XREAD returns entries after an ID", async () => {
    expect(await client.call("XREAD", "STREAMS", "r", "2-0")).toEqual([
      ["r", [["3-0", ["c", "3"]]]],
    ]);
  });

  test("XREAD BLOCK with $ wakes up on a new entry", async () => {
    const reader = await connect(server.port);
    reader.send("XREAD", "BLOCK", 0, "STREAMS", "r", "$");
    expect(await reader.hasReplyWithin(100)).toBe(false);
    await client.call("XADD", "r", "4-0", "d", "4");
    expect(await reader.next()).toEqual([["r", [["4-0", ["d", "4"]]]]]);
    reader.close();
  });

  test("XREAD BLOCK times out with a null reply", async () => {
    expect(
      await client.call("XREAD", "BLOCK", 100, "STREAMS", "r", "$"),
    ).toBeNull();
  });
});

describe("transactions", () => {
  test("MULTI queues commands and EXEC runs them atomically", async () => {
    expect(await client.call("MULTI")).toBe("OK");
    expect(await client.call("SET", "tx", "10")).toBe("QUEUED");
    expect(await client.call("INCR", "tx")).toBe("QUEUED");
    expect(await client.call("EXEC")).toEqual(["OK", 11]);
  });

  test("errors inside EXEC do not abort other commands", async () => {
    await client.call("SET", "notnum", "abc");
    await client.call("MULTI");
    await client.call("INCR", "notnum");
    await client.call("SET", "after", "ok");
    const replies = (await client.call("EXEC")) as unknown[];
    expect(replies[0]).toBeInstanceOf(RespError);
    expect(replies[1]).toBe("OK");
  });

  test("DISCARD and misuse errors", async () => {
    expect(await client.call("EXEC")).toBeInstanceOf(RespError);
    expect(await client.call("DISCARD")).toBeInstanceOf(RespError);
    await client.call("MULTI");
    expect(await client.call("MULTI")).toBeInstanceOf(RespError);
    await client.call("SET", "discarded", "1");
    expect(await client.call("DISCARD")).toBe("OK");
    expect(await client.call("GET", "discarded")).toBeNull();
  });

  test("WATCH aborts EXEC if a watched key changes", async () => {
    const other = await connect(server.port);
    await client.call("SET", "balance", "100");
    await client.call("WATCH", "balance");
    await other.call("SET", "balance", "50");
    await client.call("MULTI");
    await client.call("SET", "balance", "0");
    expect(await client.call("EXEC")).toBeNull();
    expect(await client.call("GET", "balance")).toBe("50");
    other.close();
  });

  test("WATCH succeeds when the key is untouched", async () => {
    await client.call("WATCH", "balance");
    await client.call("MULTI");
    await client.call("INCR", "balance");
    expect(await client.call("EXEC")).toEqual([51]);
  });
});

describe("pub/sub", () => {
  test("PUBLISH delivers to every subscriber of a channel", async () => {
    const sub1 = await connect(server.port);
    const sub2 = await connect(server.port);
    expect(await sub1.call("SUBSCRIBE", "news")).toEqual([
      "subscribe",
      "news",
      1,
    ]);
    await sub2.call("SUBSCRIBE", "news");
    expect(await client.call("PUBLISH", "news", "hello")).toBe(2);
    expect(await sub1.next()).toEqual(["message", "news", "hello"]);
    expect(await sub2.next()).toEqual(["message", "news", "hello"]);
    expect(await client.call("PUBLISH", "empty-channel", "x")).toBe(0);
    sub1.close();
    sub2.close();
  });

  test("subscribed clients may only run pub/sub commands", async () => {
    const sub = await connect(server.port);
    await sub.call("SUBSCRIBE", "a");
    expect(await sub.call("GET", "x")).toBeInstanceOf(RespError);
    expect(await sub.call("UNSUBSCRIBE", "a")).toEqual(["unsubscribe", "a", 0]);
    expect(await sub.call("GET", "greeting")).toBe("hello");
    sub.close();
  });
});
