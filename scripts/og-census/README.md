# `scripts/og-census/`: the `.og` census tool

**What lives here.** The tool that cuts [`src/protocols/og/census.json`](../../src/protocols/og/census.json): for every
`.og` name that had a content record at one block, what the resolver's rule makes of its history there
([`DESIGN.md`](../../src/protocols/og/DESIGN.md) section The census). The file the build ships is this tool's output,
and anyone who runs it at the same block gets the same bytes.

| File | What it does |
|---|---|
| [`run.mjs`](run.mjs) | The command: bundles `main.ts` with esbuild into `.cache/og-census/` and runs it, so the TypeScript the resolver is written in runs as it is |
| [`main.ts`](main.ts) | Arguments, the two nodes, the file |
| [`cut.ts`](cut.ts) | The census at one block: the pinned history checked, the names found, each name's entry cut by the resolver's own `censusEntryOf` |
| [`rpc.ts`](rpc.ts) | One public node as a chain: JSON-RPC over `fetch`, a pace per node, a busy answer asked again |
| [`agree.ts`](agree.ts) | Two nodes as one chain: every read made of both and compared |
| [`logs.ts`](logs.ts) | A log query over millions of blocks, read as ranges of 7,500 blocks, three at a time |
| [`validate.ts`](validate.ts) | `--validate`: a sample of the shared log read, read again name by name and compared |

**Not tied to Electron.** Durable. A developer tool: nothing in the build runs it, and `npm install` never does.

**What it depends on.** [`src/protocols/og/`](../../src/protocols/og/) (the pins, the name rules, the freshness rule, the
census type, the reads of a name's state), the `Eip1193Provider` type of
[`src/protocols/ens/resolver.ts`](../../src/protocols/ens/resolver.ts), `viem`, and `esbuild` (the build's own bundler).
The rest of `scripts/` imports nothing from `src/`, because a guard must not depend on the code it guards; this folder
is the exception, since its job is to apply the resolver's own rule, so a census can never be cut by a rule the
resolver does not run.

**What it must never import.** `electron`, and anything of `src/` outside the files above.

## The command

```bash
node scripts/og-census/run.mjs --validate
```

| Argument | Does |
|---|---|
| none | Cuts at the newest block both nodes call finalized and writes `src/protocols/og/census.json` |
| `--block N` | Cuts at block `N`. The nodes need its state: both keep archive state today |
| `--out PATH` | Writes there instead |
| `--check` | Cuts again at the file's own block and says whether it is the same file (exit 0), or not (exit 1) |
| `--validate` | After the cut, reads a sample of the shared log read name by name (below) and compares |

Progress goes to stderr. The exit code is 0 when the file was written and `--validate` found no difference.

**The output replaces `src/protocols/og/census.json` at every release.** The resolver scans every block since the
census's own, and servers that are not archive nodes refuse logs from about 40 hours back, so a census older than that
makes names `unavailable` ([`DESIGN.md`](../../src/protocols/og/DESIGN.md) section The tail). Cut it just before the tag
and commit it with the release
([`release-checklist.md`](../../docs/development/release-checklist.md) section Before tagging a release).

**How long it takes.** About an hour: the registry's whole history, 3,500 ranges of 7,500 blocks, and the resolver
proxy's, each asked of two nodes that answer a few requests a second. At block 26,505,416 the cut took 58 minutes,
and `--validate` four more: 18,070 requests in all, a quarter of them answered busy and asked again. Run it in the
background (`nice -n 19 node scripts/og-census/run.mjs --validate 2> census.log &`) and read the log's last lines.
Never two at once: MEV Blocker answers 429 above about three requests a second, and a second cut only makes both slower.

## The two nodes, and why both

`https://rpc.mevblocker.io` and `https://gateway.tenderly.co/public/mainnet`, or any two others in `OG_RPC_A` and
`OG_RPC_B`. **Every read is made of both and compared; two answers that differ stop the cut**, naming the read. A public
node can leave out a log that exists, and a census read from one node alone would be that node's word. Two independent
operators saying the same make the file one a reader of this repository can reproduce. Each node must serve
`eth_getLogs` over a range of several thousand blocks for a rare topic, archive state, and `eth_getTransactionByHash`
(the call behind each registry log of a name is read from its transaction). Both nodes must also call the cut block the
same block: the hash of it is in the file.

## What it reads, and how it reads it faster than name by name

1. The block's hash, and the resolver proxy's implementation and every `Upgraded` log, which must be the pinned ones
   (`pins.ts`), or the cut stops.
2. The names to cut: every name that ever had a `SetTextRecord` log, and every name whose registry `content` slot holds a
   value at the block (found from the registry's `Changed` logs since `REGISTRY_CONTENT_FLOOR`). Only a label the
   resolver answers counts (`ogLabelFromHost`: one ASCII label, ENSIP-15 normal, at most 32 bytes).
3. For each name, its state at the block and its whole history of registry and resolver logs, and for a wrapped name the
   wrapper's transfers of its token; the freshness rule turns them into the entry.

A query over millions of blocks is asked as ranges of 7,500 blocks (MEV Blocker refuses more than 10,000), three at a time,
each range of both nodes. Each node takes its requests at least 200 ms apart, and one that answers 429, a server error
or not at all is asked again after one to two seconds, up to 40 requests, before the cut stops.

The history of every name is read **once for all of them**: one query over the registry's life with topic 1 as the list of
all the names' keys, then split by key. Asked name by name it is the same read repeated for each name: hours instead of
an hour. `--validate` shows the two are the same logs: it reads every range that has a log of a name, and 60 others, name
by name with the filter one name alone would be read with, and fails on any difference.
