import { spawn, type Subprocess } from "bun";
import { mkdtempSync, rmSync } from "fs";
import { Socket, createServer } from "net";
import { tmpdir } from "os";
import { join } from "path";

export class RespError {
  constructor(public message: string) {}
}

export type Reply = string | number | null | Reply[] | RespError;

const MAIN = join(import.meta.dir, "..", "app", "main.ts");

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "redis-ts-test-"));
}

export function removeDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

export type ServerHandle = {
  port: number;
  proc: Subprocess;
  stop: () => Promise<void>;
};

export async function startServer(args: string[] = []): Promise<ServerHandle> {
  const port = await freePort();
  const proc = spawn(["bun", "run", MAIN, "--port", String(port), ...args], {
    stdout: "ignore",
    stderr: "inherit",
  });
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      const client = await connect(port);
      client.close();
      break;
    } catch {
      if (Date.now() > deadline) {
        proc.kill();
        throw new Error(`server on port ${port} did not start`);
      }
      await Bun.sleep(50);
    }
  }
  return {
    port,
    proc,
    stop: async () => {
      proc.kill();
      await proc.exited;
    },
  };
}

export function encodeCommand(args: (string | number)[]): Buffer {
  const parts = args.map((arg) => {
    const data = Buffer.from(String(arg));
    return Buffer.concat([
      Buffer.from(`$${data.length}\r\n`),
      data,
      Buffer.from("\r\n"),
    ]);
  });
  return Buffer.concat([Buffer.from(`*${args.length}\r\n`), ...parts]);
}

export function parseReply(
  buf: Buffer,
  offset = 0,
): { value: Reply; offset: number } | null {
  if (offset >= buf.length) return null;
  const lineEnd = buf.indexOf("\r\n", offset);
  if (lineEnd === -1) return null;
  const type = String.fromCharCode(buf[offset]);
  const line = buf.toString("utf8", offset + 1, lineEnd);
  const next = lineEnd + 2;
  switch (type) {
    case "+":
      return { value: line, offset: next };
    case "-":
      return { value: new RespError(line), offset: next };
    case ":":
      return { value: Number(line), offset: next };
    case "$": {
      const length = Number(line);
      if (length === -1) return { value: null, offset: next };
      if (buf.length < next + length + 2) return null;
      return {
        value: buf.toString("utf8", next, next + length),
        offset: next + length + 2,
      };
    }
    case "*": {
      const count = Number(line);
      if (count === -1) return { value: null, offset: next };
      const items: Reply[] = [];
      let position = next;
      for (let i = 0; i < count; i++) {
        const item = parseReply(buf, position);
        if (item === null) return null;
        items.push(item.value);
        position = item.offset;
      }
      return { value: items, offset: position };
    }
    default:
      throw new Error(`unexpected RESP type '${type}'`);
  }
}

export class Client {
  private buffer = Buffer.alloc(0);
  private replies: Reply[] = [];
  private waiters: ((reply: Reply) => void)[] = [];

  constructor(private socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      while (true) {
        const parsed = parseReply(this.buffer);
        if (parsed === null) break;
        this.buffer = this.buffer.subarray(parsed.offset);
        const waiter = this.waiters.shift();
        if (waiter) waiter(parsed.value);
        else this.replies.push(parsed.value);
      }
    });
  }

  next(timeoutMs = 3000): Promise<Reply> {
    if (this.replies.length > 0) {
      return Promise.resolve(this.replies.shift() as Reply);
    }
    return new Promise((resolve, reject) => {
      const waiter = (reply: Reply) => {
        clearTimeout(timer);
        resolve(reply);
      };
      const timer = setTimeout(() => {
        this.waiters.splice(this.waiters.indexOf(waiter), 1);
        reject(new Error("timed out waiting for reply"));
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }

  async hasReplyWithin(ms: number): Promise<boolean> {
    try {
      const reply = await this.next(ms);
      this.replies.unshift(reply);
      return true;
    } catch {
      return false;
    }
  }

  send(...args: (string | number)[]): void {
    this.socket.write(encodeCommand(args));
  }

  sendRaw(data: Buffer | string): void {
    this.socket.write(data);
  }

  async call(...args: (string | number)[]): Promise<Reply> {
    this.send(...args);
    return this.next();
  }

  close(): void {
    this.socket.destroy();
  }
}

export function connect(port: number): Promise<Client> {
  return new Promise((resolve, reject) => {
    const socket = new Socket();
    socket.once("error", reject);
    socket.connect(port, "127.0.0.1", () => {
      socket.off("error", reject);
      resolve(new Client(socket));
    });
  });
}

export async function eventually(
  fn: () => Promise<boolean>,
  timeoutMs = 3000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!(await fn())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await Bun.sleep(25);
  }
}
