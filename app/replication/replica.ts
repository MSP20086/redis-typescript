import { createConnection } from "net";
import { handleConnection } from "../connection";
import { bulkArray } from "../resp/encoder";
import { parseRdbTransfer, parseSimpleString } from "../resp/parser";
import type { RedisState } from "../types";

type HandshakeStep = {
  command: string[];
  accept: (reply: string) => boolean;
};

export function connectToMaster(
  master: { host: string; port: number },
  listeningPort: number,
  state: RedisState,
): void {
  const steps: HandshakeStep[] = [
    { command: ["PING"], accept: (reply) => reply === "PONG" },
    {
      command: ["REPLCONF", "listening-port", String(listeningPort)],
      accept: (reply) => reply === "OK",
    },
    {
      command: ["REPLCONF", "capa", "psync2"],
      accept: (reply) => reply === "OK",
    },
    {
      command: ["PSYNC", "?", "-1"],
      accept: (reply) => {
        const match = /^FULLRESYNC (\S+) (\d+)$/.exec(reply);
        if (match === null) {
          return false;
        }
        state.replication.replid = match[1];
        state.replication.offset = Number(match[2]);
        return true;
      },
    },
  ];
  let step = 0;
  let pending: Buffer = Buffer.alloc(0);
  const masterName = `${master.host}:${master.port}`;

  const socket = createConnection(master, () =>
    socket.write(bulkArray(steps[0].command)),
  );

  function advance(): boolean {
    while (step < steps.length) {
      const reply = parseSimpleString(pending, 0);
      if (reply === null) {
        return false;
      }
      pending = pending.subarray(reply.offset);
      const { command, accept } = steps[step];
      if (!accept(reply.value)) {
        throw new Error(`unexpected reply '${reply.value}' to ${command[0]}`);
      }
      step++;
      if (step < steps.length) {
        socket.write(bulkArray(steps[step].command));
      }
    }
    const rdb = parseRdbTransfer(pending, 0);
    if (rdb === null) {
      return false;
    }
    pending = pending.subarray(rdb.offset);
    return true;
  }

  const onError = (err: Error) =>
    console.error(`Connection to master ${masterName} failed:`, err.message);

  const onHandshakeData = (data: Buffer) => {
    pending = Buffer.concat([pending, data]);
    let done: boolean;
    try {
      done = advance();
    } catch (err) {
      console.error(
        `Handshake with master ${masterName} failed:`,
        (err as Error).message,
      );
      socket.destroy();
      return;
    }
    if (done) {
      socket.off("data", onHandshakeData);
      socket.off("error", onError);
      handleConnection(socket, state, {
        fromMaster: true,
        initialData: pending,
      });
    }
  };

  socket.on("data", onHandshakeData);
  socket.on("error", onError);
  socket.on("close", () =>
    console.log(`Connection to master ${masterName} closed`),
  );
}
