import type { Socket } from "net";
import type { AppendFsync, ServerConfig } from "./config";

type BaseValue = {
  expiresAt: number | null;
};

export type StringValue = BaseValue & {
  type: "string";
  value: Buffer;
};

export type ListValue = BaseValue & {
  type: "list";
  value: Buffer[];
};

export type StreamId = {
  ms: bigint;
  seq: bigint;
};

export type StreamEntry = {
  id: StreamId;
  fields: Buffer[];
};

export type StreamValue = BaseValue & {
  type: "stream";
  value: StreamEntry[];
};

export type StoredValue = StringValue | ListValue | StreamValue;

export type WaitingClient = {
  connection: Socket;
  keys: string[];
  serve: (key: string) => Buffer | null;
  resolve: (response: Buffer) => void;
  timer: NodeJS.Timeout | null;
};

export type AofWriter = {
  fd: number;
  fsync: AppendFsync;
};

export type Storage = Map<string, StoredValue>;
export type WaitingClients = Map<string, WaitingClient[]>;

export type RedisState = {
  storage: Storage;
  waitingClients: WaitingClients;
  readyKeys: Set<string>;
  watchers: Map<string, Set<ClientState>>;
  replication: ReplicationState;
  config: ServerConfig;
  aof: AofWriter | null;
  channels: Map<string, Set<Socket>>;
};

export type AckWaiter = {
  target: number;
  needed: number;
  resolve: (response: Buffer) => void;
  timer: NodeJS.Timeout | null;
};

export type ReplicationState = {
  role: "master" | "slave";
  replid: string;
  offset: number;
  replicas: Map<Socket, number>;
  ackWaiters: AckWaiter[];
};

export type ClientState = {
  queued: Buffer[][] | null;
  watching: Set<string>;
  dirty: boolean;
  subscriptions: Set<string>;
};

export type CommandContext = {
  state: RedisState;
  connection: Socket;
  client: ClientState;
  canBlock: boolean;
};

export type CommandHandler = (
  args: Buffer[],
  ctx: CommandContext,
) => Buffer | Promise<Buffer>;
