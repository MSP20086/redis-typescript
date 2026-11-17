export type AppendFsync = "always" | "everysec" | "no";

export type ServerConfig = {
  host: string;
  port: number;
  replicaOf: { host: string; port: number } | null;
  dir: string;
  dbfilename: string | null;
  appendonly: boolean;
  appenddirname: string;
  appendfilename: string;
  appendfsync: AppendFsync;
};

function requireValue(value: string | undefined, flag: string): string {
  if (value === undefined || value === "") {
    throw new Error(`${flag}: missing value`);
  }
  return value;
}

function requireChoice<T extends string>(
  value: string | undefined,
  flag: string,
  choices: readonly T[],
): T {
  const choice = requireValue(value, flag);
  if (!choices.includes(choice as T)) {
    throw new Error(`${flag}: expected one of ${choices.join(", ")}`);
  }
  return choice as T;
}

function parsePort(text: string | undefined, flag: string): number {
  const port = Number(text);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`${flag}: invalid port '${text ?? ""}'`);
  }
  return port;
}

export function parseConfig(args: string[]): ServerConfig {
  const config: ServerConfig = {
    host: "127.0.0.1",
    port: 6379,
    replicaOf: null,
    dir: process.cwd(),
    dbfilename: null,
    appendonly: false,
    appenddirname: "appendonlydir",
    appendfilename: "appendonly.aof",
    appendfsync: "everysec",
  };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    const value = args[i + 1];
    switch (flag) {
      case "--port":
        config.port = parsePort(value, flag);
        i++;
        break;
      case "--replicaof": {
        const [host, port] = (value ?? "").trim().split(/\s+/);
        if (!host) {
          throw new Error(`${flag}: expected "<host> <port>"`);
        }
        config.replicaOf = { host, port: parsePort(port, flag) };
        i++;
        break;
      }
      case "--dir":
        config.dir = requireValue(value, flag);
        i++;
        break;
      case "--dbfilename":
        config.dbfilename = requireValue(value, flag);
        i++;
        break;
      case "--appendonly":
        config.appendonly = requireChoice(value, flag, ["yes", "no"]) === "yes";
        i++;
        break;
      case "--appenddirname":
        config.appenddirname = requireValue(value, flag);
        i++;
        break;
      case "--appendfilename":
        config.appendfilename = requireValue(value, flag);
        i++;
        break;
      case "--appendfsync":
        config.appendfsync = requireChoice(value, flag, [
          "always",
          "everysec",
          "no",
        ]);
        i++;
        break;
      default:
        throw new Error(`unknown option '${flag}'`);
    }
  }
  return config;
}
