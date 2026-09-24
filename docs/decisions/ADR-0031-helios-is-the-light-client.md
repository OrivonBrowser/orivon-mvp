# ADR-0031: Helios is the light client, admitted as a WebAssembly dependency

- **Status:** accepted
- **Date:** 2026-09-24
- **Type:** architecture / security
- **Decided by:** owner, for a light client proving `.eth` names and starting at launch
  (`ens-ipfs-plan.md` §Decisions taken). AI recommendation, for Helios and the conditions below.

## Decision

`@a16z/helios` is the light client that proves `.eth` names (`ADR-0030`). It is a Rust program
compiled to WebAssembly and shipped inside an npm package. It is admitted on these conditions, all
of which the verifier host enforces:

- **Pinned exactly** (`0.11.1`, no range), and its npm provenance attestation checked on every bump
  with `npm audit signatures`.
- **Runs only in the verifier host**, a utility process, never in the main process or a renderer.
- **Reaches the network only through an allowlist**: before it loads, the host's global `fetch`
  becomes one that reaches only the configured execution RPCs and beacon API, and `WebSocket` is
  removed. Its WebAssembly, carried inside the package as a `data:` URL, is the one exception, and
  touches no network.
- **Always given a checkpoint Orivon chose and checked**: the newer of the release's and the last
  one this install verified, never older than 14 days, and never malformed. Helios checks neither
  age nor format, and silently falls back to a checkpoint compiled into it, about a year old.
- **Wrapped where the spike found it fails**: a `WorkerGlobalScope` shim, without which its timer
  panics and ends the client on the first failed consensus request; a URL on every response it
  receives, without which it throws inside its WebAssembly and ends the process; its revert text
  turned into the shape viem reads, without which CCIP-Read never starts; and a deadline on every
  resolution.

## Context

The owner decided that a `.eth` name is proven by a light client started at launch. The spike
measured Helios in an Electron 44 utility process (`docs/planning/spike-results/ens-ipfs.md`
§EI-1b): it initialises in about 260 ms, never delays the first window, syncs in 1 to 2 s from a
checkpoint up to 10 days old, and returned no wrong value under any tampering tried.

**Why it breaches neither of the rules it looks as if it might.** `ADR-0002` makes this repository
TypeScript only; that rule bounds the code written here, and none of Helios is written here. Rule 8
forbids native modules, because a module that compiles at install time breaks running from source
on Windows and macOS; WebAssembly compiles nothing at install time and runs wherever Node runs.
`check:natives` passes with Helios installed.

## Alternatives considered

**Reading names from an ordinary RPC.** No proof: the RPC decides what a name points to, which is
the one thing `ADR-0030` exists to prevent.

**Lodestar's light client and prover** (`@lodestar/prover`), written in TypeScript. Not evaluated:
it brings the ethereumjs VM and Lodestar's API, config and type packages, and whether that tree
passes `check:natives` was not checked. It is the obvious candidate if Helios has to go.

**A light client written here.** The sync-committee protocol and EVM state proofs are exactly the
kind of subsystem Rule 6 says not to reinvent.

## Reasoning

Helios does the whole job (a verified EIP-1193 provider over any RPC and beacon API) in a package
with two JavaScript dependencies, and its failures are now known and wrapped. Confining it to the
verifier host means a bug in it, or in its WebAssembly, costs `.eth` names and nothing else: the
shell restarts the host with backoff.

## Consequences

- **An 11.7 MB package**, most of it the WebAssembly inlined as base64, in every install.
- **About 150 to 200 MB of resident memory** in the verifier host, and about **20 MB an hour** of
  beacon traffic, from launch until quit.
- **Only one keyless HTTPS beacon API passed** (`ethereum-beacon-api.publicnode.com`), so the light
  client has a single point of failure on the consensus side (`open-questions.md` A253). The
  execution side fails over across three RPCs, per request.
- **Every bump is a review**: the four wrappers above rest on strings and behaviours of `0.11.1`,
  and `src/verifier-host/tests/live-ens.test.ts` (opt-in, live) is the check that they still hold.

## Reversibility

- **Cost to reverse:** cheap to moderate. The light client sits behind one EIP-1193 provider in
  `src/verifier-host/light-client.ts`; the ENS resolver, the checkpoint handling and everything
  above them would not change.
- **What would make us revisit:** a Helios release that breaks one of the wrappers; a supply-chain
  concern about the package; or a pure-TypeScript light client that passes `check:natives` and the
  same tampering tests.
