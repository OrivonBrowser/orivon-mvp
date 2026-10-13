# Upstream

- Source: https://github.com/nymtech/nym, crate `wasm/smolmix` (`nym-smolmix-wasm`)
- Tag: `nym-binaries-v2026.20-glasgow`
- Commit: `28904698fd68337cc722d51ab21f29f4fd6c56ce`
- License: Apache-2.0 (`LICENSES/Apache-2.0.txt` in the clone, which the published files carry as `LICENSE`). Nym's
  tree has no `NOTICE` file, so none is published. The crates the module is compiled from are under Apache-2.0, MIT,
  BSD-2-Clause, BSD-3-Clause, ISC, 0BSD, CC0-1.0, MPL-2.0 (two crates), CDLA-Permissive-2.0, Unicode-3.0 or Zlib; none
  is GPL. The published files carry each crate's licence text and copyright notice as `THIRD_PARTY_LICENSES`, which
  the build makes with `cargo-about` from the lockfile, for the `wasm32-unknown-unknown` target alone, and fails if a
  crate has a licence `about.toml` does not accept.
- Vendored: only the patch below. Nym's source is cloned at build time into a cache outside this repository and is
  never committed.

## What this directory holds

| File | Holds |
|---|---|
| `smolmix-raw-tcp-udp.patch` | The one change to Nym's source |
| `about.toml`, `third-party-licenses.hbs` | The licences `cargo-about` accepts, and the plain-text template of `THIRD_PARTY_LICENSES` |
| `README.md` | Copied into the published directory as its `README.md` |
| `UPSTREAM.md` | This page |

`scripts/build-nym-tunnel.mjs` builds it. The published files, their sizes and their sha256 are pinned in
`resources/nym-tunnel/nym-tunnel.json`, which is what the browser trusts: the build is a way to make the files again,
never a step of installing or running Orivon.

## Patch

1. **Raw TCP and UDP.** Adds `wasm/smolmix/src/raw.rs` (177 lines) and its `mod raw;` line in `src/lib.rs`. It
   exports two wasm-bindgen functions:
   - `connectTcp(host, port)` resolves the name through the mixnet tunnel's own DNS and returns a handle with
     `read()` (a chunk, or `null` at the end), `write(bytes)` and `close()`;
   - `bindUdp()` returns a handle with `sendTo(host, port, bytes)`, `recv(timeoutMs?)` and `close()`.

   Reason: the crate exports `mixFetch`, `mixWebSocket` and `mixDNS`, which carry HTTP, WebSocket and DNS only.
   The tunnel for apps (`docs/planning/per-app-route-plan.md`) carries any TCP stream and UDP datagrams through one
   SOCKS5 server, so the module needs sockets underneath its fetch. Names are never resolved on this computer.

## Build

- Rust 1.99.0 with the `wasm32-unknown-unknown` target (rustup), `git` and `tar`.
- `wasm-bindgen` 0.2.122, `wasm-pack` 0.15.0 and `cargo-about` 0.9.2: the release archives, each checked against its pinned sha256 (the
  digests are the ones GitHub publishes for the release; `cargo-about` has none for macOS on Intel, where the build stops), fetched into the cache. The version of `wasm-bindgen` is the
  one Nym's `Cargo.lock` pins.
- The command is the crate's own, `wasm-pack build --scope nymproject --target web --out-name smolmix_wasm`, from
  `wasm/smolmix` (its Makefile target `build-rust` minus `mark-pkg-private`, which only edits a `package.json` that is
  not published). The crate turns `wasm-opt` off for its release profile. The build must not change `Cargo.lock`.
- The paths of the source, the cargo home and the Rust sysroot are rewritten (`--remap-path-prefix`) to fixed ones, so
  the output does not depend on where it was built.

Reproducibility: the build is byte-reproducible on Linux x86-64 with Rust 1.99.0. Three builds in cache directories
of different names, one of them from a fresh clone with an empty `target` directory, gave the same sha256 for every
file. Two things in the module would differ otherwise, and the script fixes both: the paths of the source, the cargo
home and the sysroot (rewritten, above) and the build time Nym stamps into the module (`SOURCE_DATE_EPOCH` is set to
the commit's time). Not yet compared: another operating system, another CPU architecture, another Rust release, so a
build there may differ; the manifest's hashes, not the build, are what the browser checks.

## Updating

Change the tag and commit in `scripts/build-nym-tunnel.mjs`, check that the patch still applies (`git apply
--check`), build, measure it again as `docs/planning/nym-tunnel-plan.md` Step 1 does, publish the directory to IPFS and
write the new CID and hashes into the manifest.
