import {
  publishMessage,
  subscribeChannel,
  unsubscribeChannel,
} from "../pubsub";
import {
  array,
  bulkString,
  integer,
  NULL_BULK_STRING,
  wrongArgs,
} from "../resp/encoder";
import type { CommandHandler } from "../types";

function confirmation(
  kind: "subscribe" | "unsubscribe",
  channel: string | null,
  count: number,
): Buffer {
  return array([
    bulkString(kind),
    channel === null ? NULL_BULK_STRING : bulkString(channel),
    integer(count),
  ]);
}

export const subscribe: CommandHandler = (
  args,
  { state, client, connection },
) => {
  if (args.length === 0) {
    return wrongArgs("subscribe");
  }
  const replies: Buffer[] = [];
  for (const arg of args) {
    const channel = arg.toString();
    subscribeChannel(state, client, connection, channel);
    replies.push(confirmation("subscribe", channel, client.subscriptions.size));
  }
  return Buffer.concat(replies);
};

export const unsubscribe: CommandHandler = (
  args,
  { state, client, connection },
) => {
  const channels =
    args.length > 0
      ? args.map((arg) => arg.toString())
      : [...client.subscriptions];
  if (channels.length === 0) {
    return confirmation("unsubscribe", null, 0);
  }
  const replies: Buffer[] = [];
  for (const channel of channels) {
    unsubscribeChannel(state, client, connection, channel);
    replies.push(
      confirmation("unsubscribe", channel, client.subscriptions.size),
    );
  }
  return Buffer.concat(replies);
};

export const publish: CommandHandler = (args, { state }) => {
  if (args.length !== 2) {
    return wrongArgs("publish");
  }
  return integer(publishMessage(state, args[0].toString(), args[1]));
};
