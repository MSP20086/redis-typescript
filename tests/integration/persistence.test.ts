import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { connect, removeDir, startServer, tempDir } from "../helpers";

let dir: string;

beforeEach(() => {
  dir = tempDir();
});

afterEach(() => {
  removeDir(dir);
});

describe("append-only file", () => {
  test("writes survive a restart (appendfsync always)", async () => {
    const args = ["--dir", dir, "--appendonly", "yes", "--appendfsync", "always"];

    const first = await startServer(args);
    const c1 = await connect(first.port);
    await c1.call("SET", "name", "redis");
    await c1.call("INCR", "visits");
    await c1.call("INCR", "visits");
    await c1.call("RPUSH", "list", "a", "b", "c");
    await c1.call("LPOP", "list");
    await c1.call("XADD", "events", "1-1", "type", "login");
    await c1.call("GET", "name");
    c1.close();
    await first.stop();

    const aof = readFileSync(
      join(dir, "appendonlydir", "appendonly.aof.1.incr.aof"),
      "utf8",
    );
    expect(aof).toContain("SET");
    expect(aof).not.toContain("GET");
    expect(existsSync(join(dir, "appendonlydir", "appendonly.aof.manifest"))).toBe(true);

    const second = await startServer(args);
    const c2 = await connect(second.port);
    expect(await c2.call("GET", "name")).toBe("redis");
    expect(await c2.call("GET", "visits")).toBe("2");
    expect(await c2.call("LRANGE", "list", 0, -1)).toEqual(["b", "c"]);
    expect(await c2.call("XRANGE", "events", "-", "+")).toEqual([
      ["1-1", ["type", "login"]],
    ]);
    c2.close();
    await second.stop();
  });

  test("only committed transactions are logged", async () => {
    const args = ["--dir", dir, "--appendonly", "yes", "--appendfsync", "always"];
    const first = await startServer(args);
    const c1 = await connect(first.port);
    await c1.call("MULTI");
    await c1.call("SET", "kept", "1");
    await c1.call("EXEC");
    await c1.call("MULTI");
    await c1.call("SET", "dropped", "1");
    await c1.call("DISCARD");
    c1.close();
    await first.stop();

    const second = await startServer(args);
    const c2 = await connect(second.port);
    expect(await c2.call("GET", "kept")).toBe("1");
    expect(await c2.call("GET", "dropped")).toBeNull();
    c2.close();
    await second.stop();
  });
});

describe("RDB snapshot", () => {
  test("loads keys from an RDB file at startup", async () => {
    const str = (s: string) => [s.length, ...Buffer.from(s)];
    writeFileSync(
      join(dir, "dump.rdb"),
      Buffer.concat([
        Buffer.from("REDIS0011"),
        Buffer.from([
          0xfe, 0x00, 0xfb, 0x02, 0x00,
          0x00, ...str("apple"), ...str("red"),
          0x00, ...str("banana"), ...str("yellow"),
          0xff,
        ]),
        Buffer.alloc(8),
      ]),
    );
    const server = await startServer(["--dir", dir, "--dbfilename", "dump.rdb"]);
    const client = await connect(server.port);
    expect(await client.call("GET", "apple")).toBe("red");
    expect(((await client.call("KEYS", "*")) as string[]).sort()).toEqual([
      "apple",
      "banana",
    ]);
    expect(await client.call("CONFIG", "GET", "dbfilename")).toEqual([
      "dbfilename",
      "dump.rdb",
    ]);
    client.close();
    await server.stop();
  });
});
