export class CommandError extends Error {}

export class WrongTypeError extends CommandError {
  constructor() {
    super("WRONGTYPE Operation against a key holding the wrong kind of value");
  }
}
