export function copyAll(values: Buffer[]): Buffer[] {
  return values.map((v) => Buffer.from(v));
}
