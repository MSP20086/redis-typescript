# redis-typescript

[![test](https://github.com/MSP20086/redis-typescript/actions/workflows/test.yml/badge.svg)](https://github.com/MSP20086/redis-typescript/actions/workflows/test.yml)

A Redis-compatible in-memory data store written from scratch in TypeScript on [Bun](https://bun.sh), with
**leader–follower replication**, **AOF/RDB persistence**, **optimistic-locking transactions**, **streams**,
**blocking operations** and **pub/sub**. It speaks the RESP wire protocol, so the stock `redis-cli`,
`redis-benchmark` and standard Redis client libraries work against it without changes.

**At a glance**

- About **2,100 lines** of TypeScript, no runtime dependencies. Networking uses only `node:net`.
- **25 commands** across strings, lists, streams, transactions, pub/sub and replication.
- **~64K ops/s** for `GET`/`SET` with 50 clients, **93–94% of real Redis 7** on the same machine
  (see [benchmarks](#performance)).
- **59 tests**: unit tests plus integration tests that start real server processes, including a master with two replicas.

---

## Contents

- [Quick start](#quick-start)
- [Features](#features)
- [Architecture](#architecture)
- [Design notes](#design-notes)
- [Performance](#performance)
- [Testing](#testing)
- [Limitations and future work](#limitations-and-future-work)

## Quick start

Requires [Bun](https://bun.sh) ≥ 1.1. `redis-cli` is optional, for poking at the server.

```sh
bun install
bun run start                 # listens on 127.0.0.1:6379
```

```console
$ redis-cli SET greeting hello
OK
$ redis-cli RPUSH queue job-1 job-2
(integer) 2
$ redis-cli XADD sensor '*' temp 21.5
"1794873600000-0"
$ redis-cli KEYS '*'
1) "greeting"
2) "queue"
3) "sensor"
```

**Configuration flags** (same names as Redis):

| Flag | Default | Description |
| --- | --- | --- |
| `--port <n>` | `6379` | TCP port to listen on |
| `--replicaof "<host> <port>"` | – | Start as a replica of the given master |
| `--dir <path>` | cwd | Directory for RDB/AOF files |
| `--dbfilename <name>` | – | RDB snapshot to load at startup |
| `--appendonly yes\|no` | `no` | Enable the append-only file |
| `--appendfsync always\|everysec\|no` | `everysec` | When to `fsync` the AOF |
| `--appenddirname`, `--appendfilename` | `appendonlydir`, `appendonly.aof` | AOF location |

**Try replication locally:**

```sh
bun run start --port 6379
bun run start --port 6380 --replicaof "127.0.0.1 6379"
redis-cli -p 6379 SET user alice
redis-cli -p 6379 WAIT 1 1000      # (integer) 1, once the replica has acknowledged the write
redis-cli -p 6380 GET user         # "alice"
```

## Features

| Area | Commands / capabilities |
| --- | --- |
| **Strings** | `GET`, `SET key value [PX ms]`, `INCR` (64-bit overflow-checked) |
| **Lists** | `RPUSH`, `LPUSH`, `LRANGE` (negative indices), `LLEN`, `LPOP [count]`, `BLPOP` (multi-key, timeout, FIFO fairness) |
| **Streams** | `XADD` with explicit, partial (`ms-*`) or auto (`*`) IDs and monotonicity checks; `XRANGE`; `XREAD [BLOCK ms]` with `$` |
| **Transactions** | `MULTI`, `EXEC`, `DISCARD`, `WATCH`, `UNWATCH` (optimistic concurrency control) |
| **Pub/Sub** | `SUBSCRIBE`, `UNSUBSCRIBE`, `PUBLISH`; a subscribed connection may only run pub/sub commands |
| **Replication** | `PSYNC` handshake, write propagation, `REPLCONF ACK`/`GETACK` offset tracking, `WAIT` |
| **Persistence** | RDB loading (string keys with expiry, int-encoded values); multi-part AOF with manifest and three fsync policies |
| **Server** | `PING`, `ECHO`, `TYPE`, `KEYS <glob>`, `INFO replication`, `CONFIG GET <glob>` |

## Architecture

```
               ┌──────────────────────────── single event loop ─────────────────────────────┐
 TCP bytes ──▶ │ connection.ts ──▶ resp/parser.ts ──▶ commands/index.ts ──▶ commands/*.ts   │
               │  per-socket         incremental,       MULTI queueing,       read/write    │
               │  buffer + ordered   returns null on     pub/sub mode gate,    store.ts      │
               │  promise chain      partial frames      error mapping                       │
               │                                              │                              │
               │                                              ├──▶ propagate.ts ──▶ aof.ts   │
               │                                              │                 └─▶ replicas │
               │                                              ├──▶ watch.ts   (dirty-mark)   │
               │                                              └──▶ blocking.ts (wake BLPOP/  │
               │                                                                XREAD)       │
               └────────────────────────────────────────────────────────────────────────────┘
```

| Module | Responsibility |
| --- | --- |
| [`app/main.ts`](app/main.ts) | Boot: parse flags, load RDB, replay AOF, start the TCP server, connect to the master |
| [`app/connection.ts`](app/connection.ts) | Per-client buffering, parse → execute → reply loop, cleanup on disconnect |
| [`app/resp/`](app/resp) | Incremental, binary-safe RESP parser and reply encoder |
| [`app/commands/`](app/commands) | One module per command family, registered in a dispatch table |
| [`app/store.ts`](app/store.ts) | Typed keyspace (`string` / `list` / `stream`) with lazy expiry and `WRONGTYPE` checks |
| [`app/blocking.ts`](app/blocking.ts) | Wait queues for `BLPOP` / `XREAD BLOCK`, timeouts, ready-key wakeups |
| [`app/watch.ts`](app/watch.ts) | Key → watching-clients index used by `WATCH` |
| [`app/propagate.ts`](app/propagate.ts) | Sends each write to the AOF and to every replica |
| [`app/replication/`](app/replication) | Master side (replica registry, ACKs, `WAIT`) and replica side (handshake state machine) |
| [`app/aof.ts`](app/aof.ts), [`app/rdb.ts`](app/rdb.ts) | Persistence |

## Design notes

**Single-threaded, lock-free execution.** As in Redis, every command runs to completion on one event
loop, so no command can observe another one half-finished, and the keyspace needs no locks. Each
connection pushes its incoming data through its own promise chain. Commands from one client are
therefore executed and answered strictly in order, even when one of them (`BLPOP`, `WAIT`) suspends.

**Incremental RESP parsing.** TCP gives no message boundaries. The parser works on a per-connection
buffer and returns `null` when a frame is incomplete. The connection keeps the unparsed tail and
waits for more bytes. A single read can therefore hold half a command or fifty pipelined ones. Bulk
strings are sliced by length, not split on `\r\n`, so values can contain any bytes.

**Blocking commands without blocking the server.** `BLPOP` and `XREAD BLOCK` register a waiter on
every key they are waiting for and return a pending promise. A write to one of those keys only adds
the key to a *ready set*. After the writing command has fully finished, the dispatcher drains the set
and serves waiters in FIFO order. A `BLPOP` that pops on the master is replicated as a plain `LPOP`,
so replicas replay a deterministic command and never block.

**Optimistic transactions.** `WATCH` records the client in a key → clients index. Every write marks
the clients watching that key as *dirty*. If the client is dirty when `EXEC` runs, the queued
commands are discarded and `EXEC` returns a null array. Queued commands run one after another, and
none of them can block: inside `EXEC`, `BLPOP` and `XREAD BLOCK` return immediately, as in Redis.

**Persistence.**
- *AOF*: write commands are appended in RESP format. `appendfsync` decides whether `fsync` runs
  after every write (`always`), once a second on a timer (`everysec`) or never (`no`). Files are
  tracked through a Redis-7-style manifest. On startup the log is replayed through the normal command
  path. If the server crashed in the middle of a write and left a **truncated command** at the end,
  that tail is cut off instead of failing the whole startup.
- *RDB*: a binary parser for the snapshot format (length encodings, int-encoded strings, `ms`/`s`
  expiry opcodes). Keys that have already expired are skipped while loading.

**Replication.** A replica runs a small state machine for the handshake (`PING` → `REPLCONF
listening-port` → `REPLCONF capa psync2` → `PSYNC ? -1`). It then reads the snapshot transfer and
turns the master connection into a normal command stream, executing propagated writes without
replying to them. Both sides count replication-stream bytes as an **offset**. `WAIT n timeout`
records the master's current offset, sends `REPLCONF GETACK *`, and resolves once `n` replicas have
reported an `ACK` at or beyond that offset, or when the timeout expires.

```
replica                                  master
   │── PING ────────────────────────────────▶│
   │── REPLCONF listening-port / capa ──────▶│
   │── PSYNC ? -1 ──────────────────────────▶│
   │◀────────────── +FULLRESYNC <replid> 0 ──│
   │◀───────────────────── $<len> <RDB> ─────│
   │◀──────────── propagated writes ─────────│  master offset += bytes
   │◀──────────── REPLCONF GETACK * ─────────│  (sent by WAIT)
   │── REPLCONF ACK <offset> ───────────────▶│  WAIT resolves when ≥ n replicas reach the target
```

## Performance

Measured with `redis-benchmark` against this server **and real Redis 7.0.15 on the same machine**
(AMD Ryzen 7 250, Bun 1.4.4, loopback, 100K requests per data point, median of 3 runs on fresh servers).
Full methodology and every table: **[benchmarks/RESULTS.md](benchmarks/RESULTS.md)**.

**Throughput and latency, 50 clients, no pipelining**

| Command | redis-typescript | p99 | Redis 7 | Redis 7 p99 | vs Redis |
| --- | ---: | ---: | ---: | ---: | ---: |
| `GET` | 64.3K ops/s | 1.67 ms | 68.3K ops/s | 0.54 ms | 94% |
| `SET` | 62.5K ops/s | 2.84 ms | 67.0K ops/s | 0.66 ms | 93% |
| `RPUSH` | 62.0K ops/s | 1.54 ms | 68.1K ops/s | 0.60 ms | 91% |
| `INCR` | 59.1K ops/s | 2.99 ms | 68.2K ops/s | 0.58 ms | 87% |
| `LRANGE` (100 items) | 17.6K ops/s | 14.46 ms | 54.4K ops/s | 0.77 ms | 32% |

**Pipelining (`SET`)**

| Depth | redis-typescript | Redis 7 | vs Redis |
| ---: | ---: | ---: | ---: |
| 1 | 62.7K ops/s | 67.7K ops/s | 93% |
| 16 | 91.7K ops/s | 251.3K ops/s | 36% |
| 64 | 89.0K ops/s | 286.6K ops/s | 31% |

**Durability cost (`SET`, 50 clients)**

| Mode | redis-typescript | Redis 7 |
| --- | ---: | ---: |
| In-memory | 64.1K ops/s | 73.5K ops/s |
| AOF `everysec` | 60.3K ops/s (−6%) | 72.8K ops/s |
| AOF `always` | 1.7K ops/s | 32.4K ops/s |

**What the numbers show**

- **Without pipelining, both servers are limited by the network round trip, not by CPU.** Each request
  costs a loopback round trip, and real Redis gains only about 8% more even with a 4-thread load
  generator. In this mode the visible cost of TypeScript is **tail latency**: p99 is 2–5× higher
  because of V8 garbage collection and event-loop jitter.
- **Pipelining shows the raw per-command cost.** This server levels off around 90K ops/s
  (about 11 µs of CPU per command). Redis reaches about 290K ops/s (about 3.5 µs). Most of the gap is
  per-command `Buffer` allocation and copying in parsing and reply encoding. That same cost is why
  `LRANGE`, which builds a 100-element reply, is the slowest command.
- **`everysec` is nearly free (−6%), but `always` is not.** The server calls a synchronous `fsync` for
  every write, which blocks the event loop. Redis does *group commit*: one `fsync` per event-loop
  iteration covers every client's writes. This is the biggest improvement left to make (see below).
- **Replication** costs 34% of throughput with one replica on the same machine
  ([details](benchmarks/RESULTS.md#6-replication-overhead)). The replica competes with the master
  for CPU, so this is a pessimistic number.

Reproduce with:

```sh
bun run bench              # full suite (~8 min); writes benchmarks/RESULTS.md and results.json
bun run bench --quick      # ~30 s smoke run
bun run bench --no-baseline
```

## Testing

```sh
bun test                    # 59 tests, ~1.5 s
bun run test:unit           # parser, encoder, glob, stream IDs, config, RDB decoding
bun run test:integration    # real server processes over TCP
bun run typecheck
```

The integration tests talk to real server processes over TCP using a small RESP client
([`tests/helpers.ts`](tests/helpers.ts)). They cover:

- **Protocol:** pipelined batches; a command sent **one byte per TCP packet**; 20 concurrent clients
  incrementing a shared counter (all 500 increments are applied).
- **Blocking:** `BLPOP` FIFO fairness between waiters, `XREAD BLOCK $` wakeups, timeouts.
- **Transactions:** a `WATCH` conflict from a second client aborts `EXEC`. An error inside `EXEC`
  does not roll back the other commands, matching Redis semantics.
- **Persistence:** data survives a restart through the AOF. Reads and discarded transactions are not
  logged. A hand-built RDB file loads at startup.
- **Replication:** a master with two replicas. Strings, lists and streams propagate, `WAIT` gets
  acknowledgements from both replicas, and `BLPOP` is replicated as `LPOP`.

CI runs the typecheck and the full suite on every push ([`.github/workflows/test.yml`](.github/workflows/test.yml)).

## Limitations and future work

This is a learning project, not a drop-in replacement for Redis. Known gaps:

- **Full resync sends an empty snapshot.** A replica gets every write made after it connects, but not
  the data that already existed. Next step: serialise the keyspace to RDB during `PSYNC`.
  Partial resync (`PSYNC <replid> <offset>`) with a replication backlog is not implemented either.
- **`appendfsync always` has no group commit.** Batching writes and calling one `fsync` per event-loop
  turn should recover most of the 19× gap shown above.
- **Lists are JS arrays**, so `LPUSH` is O(n) (it runs at 66% of Redis in the benchmark, where every
  push goes to one key). A deque, like Redis's quicklist, would make both ends O(1).
- **Expiry is lazy only.** Expired keys are removed when they are next read, never by a background
  sweep, so keys that are never read again keep their memory.
- **No AOF rewrite or compaction**, and RDB loading supports only string values.
- **Command coverage:** missing `DEL`, `EXPIRE`/`TTL`, `SET … EX/NX/XX`, hashes, sets and sorted sets,
  pattern subscriptions, and inline (non-RESP) commands.
