import { describe, expect, test } from "bun:test";
import { globToRegExp } from "../../app/glob";
import {
  compareIds,
  formatId,
  MAX_SEQ,
  parseId,
  parseUint,
} from "../../app/stream-id";

describe("globToRegExp", () => {
  const matches = (pattern: string, text: string) =>
    globToRegExp(pattern).test(text);

  test("supports *, ? and character classes", () => {
    expect(matches("*", "anything")).toBe(true);
    expect(matches("user:*", "user:42")).toBe(true);
    expect(matches("user:*", "order:42")).toBe(false);
    expect(matches("h?llo", "hello")).toBe(true);
    expect(matches("h?llo", "heello")).toBe(false);
    expect(matches("h[ae]llo", "hallo")).toBe(true);
    expect(matches("h[ae]llo", "hillo")).toBe(false);
    expect(matches("h[^e]llo", "hallo")).toBe(true);
    expect(matches("h[^e]llo", "hello")).toBe(false);
  });

  test("escapes regex metacharacters and honours backslash escapes", () => {
    expect(matches("a.b", "a.b")).toBe(true);
    expect(matches("a.b", "axb")).toBe(false);
    expect(matches("a\\*b", "a*b")).toBe(true);
    expect(matches("a\\*b", "axxb")).toBe(false);
    expect(matches("(x)+", "(x)+")).toBe(true);
  });

  test("matches the whole string, across newlines", () => {
    expect(matches("ab", "xab")).toBe(false);
    expect(matches("a*b", "a\nb")).toBe(true);
  });

  test("supports case-insensitive flag", () => {
    expect(globToRegExp("DIR", "i").test("dir")).toBe(true);
  });
});

describe("stream IDs", () => {
  test("parseUint only accepts non-negative integers", () => {
    expect(parseUint("123")).toBe(123n);
    expect(parseUint("-1")).toBeNull();
    expect(parseUint("1.5")).toBeNull();
    expect(parseUint("")).toBeNull();
  });

  test("parseId handles full ids, default sequence and garbage", () => {
    expect(parseId("5-3")).toEqual({ ms: 5n, seq: 3n });
    expect(parseId("5", 0n)).toEqual({ ms: 5n, seq: 0n });
    expect(parseId("5")).toBeNull();
    expect(parseId("5-3-1")).toBeNull();
    expect(parseId("a-b")).toBeNull();
  });

  test("handles 64-bit values without precision loss", () => {
    const id = parseId(`${MAX_SEQ}-${MAX_SEQ}`);
    expect(id).toEqual({ ms: MAX_SEQ, seq: MAX_SEQ });
    expect(formatId(id!)).toBe("18446744073709551615-18446744073709551615");
  });

  test("compareIds orders by ms then seq", () => {
    expect(compareIds({ ms: 1n, seq: 9n }, { ms: 2n, seq: 0n })).toBe(-1);
    expect(compareIds({ ms: 2n, seq: 1n }, { ms: 2n, seq: 0n })).toBe(1);
    expect(compareIds({ ms: 2n, seq: 1n }, { ms: 2n, seq: 1n })).toBe(0);
  });
});
