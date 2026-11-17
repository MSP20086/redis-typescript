import { describe, expect, test } from "bun:test";
import {
  array,
  bulkArray,
  bulkString,
  error,
  integer,
  isError,
  NULL_ARRAY,
  NULL_BULK_STRING,
  simpleString,
} from "../../app/resp/encoder";
import {
  parseCommand,
  parseRdbTransfer,
  parseSimpleString,
} from "../../app/resp/parser";

const cmd = (...parts: string[]) =>
  Buffer.from(
    `*${parts.length}\r\n` +
      parts.map((p) => `$${Buffer.byteLength(p)}\r\n${p}\r\n`).join(""),
  );

describe("RESP parser", () => {
  test("parses a complete command", () => {
    const result = parseCommand(cmd("SET", "key", "value"), 0);
    expect(result?.args.map(String)).toEqual(["SET", "key", "value"]);
    expect(result?.offset).toBe(cmd("SET", "key", "value").length);
  });

  test("returns null for every incomplete prefix of a frame", () => {
    const frame = cmd("ECHO", "hello world");
    for (let i = 0; i < frame.length; i++) {
      expect(parseCommand(frame.subarray(0, i), 0)).toBeNull();
    }
  });

  test("parses pipelined commands back to back", () => {
    const buffer = Buffer.concat([cmd("PING"), cmd("GET", "a"), cmd("INCR", "n")]);
    const commands: string[][] = [];
    let offset = 0;
    for (;;) {
      const result = parseCommand(buffer, offset);
      if (result === null) break;
      commands.push(result.args.map(String));
      offset = result.offset;
    }
    expect(commands).toEqual([["PING"], ["GET", "a"], ["INCR", "n"]]);
    expect(offset).toBe(buffer.length);
  });

  test("is binary safe (CRLF and NUL bytes inside a bulk string)", () => {
    const value = "a\r\nb\0c";
    const result = parseCommand(cmd("SET", "k", value), 0);
    expect(result?.args[2].toString()).toBe(value);
  });

  test("handles empty bulk strings", () => {
    const result = parseCommand(cmd("SET", "k", ""), 0);
    expect(result?.args[2].length).toBe(0);
  });

  test("rejects malformed input", () => {
    expect(() => parseCommand(Buffer.from("+PING\r\n"), 0)).toThrow();
    expect(() => parseCommand(Buffer.from("*x\r\n"), 0)).toThrow();
    expect(() => parseCommand(Buffer.from("*1\r\n$3\r\nabcXY"), 0)).toThrow();
  });

  test("parses simple strings and RDB transfers", () => {
    expect(parseSimpleString(Buffer.from("+FULLRESYNC abc 0\r\n"), 0)).toEqual({
      value: "FULLRESYNC abc 0",
      offset: 19,
    });
    expect(parseSimpleString(Buffer.from("+OK"), 0)).toBeNull();

    const rdb = Buffer.from("$5\r\nREDIS");
    expect(parseRdbTransfer(rdb, 0)?.value.toString()).toBe("REDIS");
    expect(parseRdbTransfer(rdb.subarray(0, 7), 0)).toBeNull();
  });
});

describe("RESP encoder", () => {
  test("encodes every reply type", () => {
    expect(simpleString("OK").toString()).toBe("+OK\r\n");
    expect(error("ERR bad").toString()).toBe("-ERR bad\r\n");
    expect(integer(42).toString()).toBe(":42\r\n");
    expect(integer(9007199254740993n).toString()).toBe(":9007199254740993\r\n");
    expect(bulkString("hi").toString()).toBe("$2\r\nhi\r\n");
    expect(bulkString("").toString()).toBe("$0\r\n\r\n");
    expect(bulkArray(["a", "bc"]).toString()).toBe("*2\r\n$1\r\na\r\n$2\r\nbc\r\n");
    expect(array([]).toString()).toBe("*0\r\n");
    expect(NULL_BULK_STRING.toString()).toBe("$-1\r\n");
    expect(NULL_ARRAY.toString()).toBe("*-1\r\n");
  });

  test("bulk string length counts bytes, not characters", () => {
    expect(bulkString("héllo").toString()).toBe("$6\r\nhéllo\r\n");
  });

  test("isError detects error replies", () => {
    expect(isError(error("ERR x"))).toBe(true);
    expect(isError(simpleString("OK"))).toBe(false);
  });

  test("encoded commands round-trip through the parser", () => {
    const encoded = bulkArray(["XADD", "s", "*", "f", "v"]);
    expect(parseCommand(encoded, 0)?.args.map(String)).toEqual([
      "XADD",
      "s",
      "*",
      "f",
      "v",
    ]);
  });
});
