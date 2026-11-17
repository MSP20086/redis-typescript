import { describe, expect, test } from "bun:test";
import { parseConfig } from "../../app/config";
import { parseRdb } from "../../app/rdb";

describe("parseConfig", () => {
  test("uses sensible defaults", () => {
    const config = parseConfig([]);
    expect(config.port).toBe(6379);
    expect(config.replicaOf).toBeNull();
    expect(config.appendonly).toBe(false);
    expect(config.appendfsync).toBe("everysec");
  });

  test("parses all supported flags", () => {
    const config = parseConfig([
      "--port", "7000",
      "--replicaof", "localhost 6379",
      "--dir", "/data",
      "--dbfilename", "dump.rdb",
      "--appendonly", "yes",
      "--appendfsync", "always",
    ]);
    expect(config.port).toBe(7000);
    expect(config.replicaOf).toEqual({ host: "localhost", port: 6379 });
    expect(config.dir).toBe("/data");
    expect(config.dbfilename).toBe("dump.rdb");
    expect(config.appendonly).toBe(true);
    expect(config.appendfsync).toBe("always");
  });

  test("rejects invalid input", () => {
    expect(() => parseConfig(["--port", "70000"])).toThrow();
    expect(() => parseConfig(["--port"])).toThrow();
    expect(() => parseConfig(["--appendfsync", "sometimes"])).toThrow();
    expect(() => parseConfig(["--replicaof", "localhost"])).toThrow();
    expect(() => parseConfig(["--bogus", "1"])).toThrow();
  });
});

function rdbFile(body: number[]): Buffer {
  return Buffer.concat([
    Buffer.from("REDIS0011"),
    Buffer.from(body),
    Buffer.from([0xff]),
    Buffer.alloc(8),
  ]);
}

const str = (s: string) => [s.length, ...Buffer.from(s)];

function u64le(value: number): number[] {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64LE(BigInt(value));
  return [...buf];
}

describe("parseRdb", () => {
  test("loads string keys, metadata and int-encoded values", () => {
    const storage = parseRdb(
      rdbFile([
        0xfa, ...str("redis-ver"), ...str("7.2.0"),
        0xfe, 0x00,
        0xfb, 0x02, 0x00,
        0x00, ...str("name"), ...str("redis"),
        0x00, ...str("count"), 0xc0, 0x7b,
      ]),
    );
    expect(storage.get("name")?.value.toString()).toBe("redis");
    expect(storage.get("count")?.value.toString()).toBe("123");
  });

  test("keeps future expiries and drops already-expired keys", () => {
    const future = Date.now() + 60_000;
    const storage = parseRdb(
      rdbFile([
        0xfc, ...u64le(future), 0x00, ...str("live"), ...str("1"),
        0xfc, ...u64le(1000), 0x00, ...str("dead"), ...str("1"),
      ]),
    );
    expect(storage.get("live")?.expiresAt).toBe(future);
    expect(storage.has("dead")).toBe(false);
  });

  test("rejects files that are not RDB", () => {
    expect(() => parseRdb(Buffer.from("hello world"))).toThrow();
  });
});
