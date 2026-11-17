import { existsSync, readFileSync } from "fs";
import type { Storage } from "./types";

const OPCODE = {
  AUX: 0xfa,
  RESIZEDB: 0xfb,
  EXPIRETIME_MS: 0xfc,
  EXPIRETIME: 0xfd,
  SELECTDB: 0xfe,
  EOF: 0xff,
} as const;

const TYPE_STRING = 0x00;
const HEADER = "REDIS";
const HEADER_LENGTH = 9;

class RdbReader {
  constructor(
    private readonly buffer: Buffer,
    public offset: number,
  ) {}

  byte(): number {
    return this.bytes(1)[0];
  }

  bytes(count: number): Buffer {
    if (this.offset + count > this.buffer.length) {
      throw new Error(`unexpected end of file at offset ${this.offset}`);
    }
    const value = this.buffer.subarray(this.offset, this.offset + count);
    this.offset += count;
    return value;
  }

  length(): { value: number; special: boolean } {
    const first = this.byte();
    switch (first >> 6) {
      case 0:
        return { value: first & 0x3f, special: false };
      case 1:
        return { value: ((first & 0x3f) << 8) | this.byte(), special: false };
      case 2:
        if (first === 0x80) {
          return { value: this.bytes(4).readUInt32BE(), special: false };
        }
        if (first === 0x81) {
          return {
            value: Number(this.bytes(8).readBigUInt64BE()),
            special: false,
          };
        }
        throw new Error(`invalid length encoding 0x${first.toString(16)}`);
      default:
        return { value: first & 0x3f, special: true };
    }
  }

  string(): Buffer {
    const { value, special } = this.length();
    if (!special) {
      return this.bytes(value);
    }
    switch (value) {
      case 0:
        return Buffer.from(String(this.bytes(1).readInt8()));
      case 1:
        return Buffer.from(String(this.bytes(2).readInt16LE()));
      case 2:
        return Buffer.from(String(this.bytes(4).readInt32LE()));
      default:
        throw new Error("LZF-compressed strings are not supported");
    }
  }
}

export function parseRdb(buffer: Buffer): Storage {
  if (
    buffer.length < HEADER_LENGTH ||
    buffer.toString("latin1", 0, 5) !== HEADER
  ) {
    throw new Error("not an RDB file");
  }
  const reader = new RdbReader(buffer, HEADER_LENGTH);
  const storage: Storage = new Map();
  let expiresAt: number | null = null;

  for (;;) {
    const opcode = reader.byte();
    switch (opcode) {
      case OPCODE.EOF:
        return storage;
      case OPCODE.AUX:
        reader.string();
        reader.string();
        break;
      case OPCODE.SELECTDB:
        reader.length();
        break;
      case OPCODE.RESIZEDB:
        reader.length();
        reader.length();
        break;
      case OPCODE.EXPIRETIME_MS:
        expiresAt = Number(reader.bytes(8).readBigUInt64LE());
        break;
      case OPCODE.EXPIRETIME:
        expiresAt = reader.bytes(4).readUInt32LE() * 1000;
        break;
      case TYPE_STRING: {
        const key = reader.string().toString();
        const value = Buffer.from(reader.string());
        if (expiresAt === null || expiresAt > Date.now()) {
          storage.set(key, { type: "string", value, expiresAt });
        }
        expiresAt = null;
        break;
      }
      default:
        throw new Error(
          `unsupported value type 0x${opcode.toString(16)} at offset ${reader.offset - 1}`,
        );
    }
  }
}

export function loadRdbFile(path: string): Storage {
  return existsSync(path) ? parseRdb(readFileSync(path)) : new Map();
}
