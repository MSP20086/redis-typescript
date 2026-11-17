import { randomBytes } from "crypto";
import { Socket, createServer } from "net";
import { join } from "path";
import { loadAof } from "./aof";
import { executeCommand } from "./commands";
import { parseConfig, type ServerConfig } from "./config";
import { createClientState, handleConnection } from "./connection";
import { loadRdbFile } from "./rdb";
import { connectToMaster } from "./replication/replica";
import type { CommandContext, RedisState, Storage } from "./types";

function exitWithError(message: string): never {
  console.error(message);
  process.exit(1);
}

function loadStorage(config: ServerConfig): Storage {
  if (config.dbfilename === null) {
    return new Map();
  }
  const path = join(config.dir, config.dbfilename);
  try {
    return loadRdbFile(path);
  } catch (err) {
    return exitWithError(`Failed to load ${path}: ${(err as Error).message}`);
  }
}

let config: ServerConfig;
try {
  config = parseConfig(process.argv.slice(2));
} catch (err) {
  exitWithError((err as Error).message);
}

const state: RedisState = {
  storage: loadStorage(config),
  waitingClients: new Map(),
  readyKeys: new Set(),
  watchers: new Map(),
  replication: {
    role: config.replicaOf === null ? "master" : "slave",
    replid: randomBytes(20).toString("hex"),
    offset: 0,
    replicas: new Map(),
    ackWaiters: [],
  },
  config,
  aof: null,
  channels: new Map(),
};

if (config.appendonly) {
  const replayCtx: CommandContext = {
    state,
    connection: new Socket(),
    client: createClientState(),
    canBlock: false,
  };
  try {
    await loadAof(state, (args) => executeCommand(args, replayCtx));
  } catch (err) {
    exitWithError(`Failed to load the AOF: ${(err as Error).message}`);
  }
}

if (config.replicaOf !== null) {
  connectToMaster(config.replicaOf, config.port, state);
}

const server = createServer((connection) =>
  handleConnection(connection, state),
);

server.listen(config.port, config.host, () =>
  console.log(`Listening on ${config.host}:${config.port}`),
);
