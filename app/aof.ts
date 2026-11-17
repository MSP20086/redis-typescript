import {
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "fs";
import { join } from "path";
import type { ServerConfig } from "./config";
import { bulkArray } from "./resp/encoder";
import { parseCommand } from "./resp/parser";
import type { RedisState } from "./types";

type ManifestEntry = { file: string; seq: number; type: string };

function parseManifest(text: string, path: string): ManifestEntry[] {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const fields = line.trim().split(/\s+/);
      const entry = new Map<string, string>();
      for (let i = 0; i + 1 < fields.length; i += 2) {
        entry.set(fields[i], fields[i + 1]);
      }
      const file = entry.get("file");
      const seq = Number(entry.get("seq"));
      const type = entry.get("type");
      if (file === undefined || !Number.isInteger(seq) || type === undefined) {
        throw new Error(`${path}: invalid manifest line '${line}'`);
      }
      return { file, seq, type };
    });
}

function prepareAofFiles(config: ServerConfig): string[] {
  const dir = join(config.dir, config.appenddirname);
  const manifestPath = join(dir, `${config.appendfilename}.manifest`);
  if (!existsSync(manifestPath)) {
    const file = `${config.appendfilename}.1.incr.aof`;
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, file), "", { flag: "a" });
    writeFileSync(manifestPath, `file ${file} seq 1 type i\n`);
  }
  const incremental = parseManifest(
    readFileSync(manifestPath, "utf8"),
    manifestPath,
  )
    .filter((entry) => entry.type === "i")
    .sort((a, b) => a.seq - b.seq);
  if (incremental.length === 0) {
    throw new Error(`${manifestPath}: no incremental AOF file listed`);
  }
  return incremental.map((entry) => join(dir, entry.file));
}

async function replayFile(
  path: string,
  run: (args: Buffer[]) => Promise<unknown>,
): Promise<void> {
  const content = readFileSync(path);
  let offset = 0;
  while (offset < content.length) {
    const parsed = parseCommand(content, offset);
    if (parsed === null) {
      console.warn(`${path}: discarding truncated command at offset ${offset}`);
      truncateSync(path, offset);
      return;
    }
    await run(parsed.args);
    offset = parsed.offset;
  }
}

export async function loadAof(
  state: RedisState,
  run: (args: Buffer[]) => Promise<unknown>,
): Promise<void> {
  const files = prepareAofFiles(state.config);
  for (const file of files) {
    await replayFile(file, run);
  }
  const fd = openSync(files[files.length - 1], "a");
  const { appendfsync } = state.config;
  if (appendfsync === "everysec") {
    setInterval(() => fsyncSync(fd), 1000).unref();
  }
  state.aof = { fd, fsync: appendfsync };
}

export function appendToAof(
  state: RedisState,
  command: (Buffer | string)[],
): void {
  const { aof } = state;
  if (aof === null) {
    return;
  }
  writeSync(aof.fd, bulkArray(command));
  if (aof.fsync === "always") {
    fsyncSync(aof.fd);
  }
}
