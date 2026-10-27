# `resources/`: files the browser ships beside its code

**What lives here.** Files the application reads at run time that are not source:
- [`default-profile/`](default-profile/): what a new profile starts with.
- [`flavours.json`](flavours.json): the apps a package can be tagged to open on first run (read by [`src/main/flavour/`](../src/main/flavour/README.md); the release workflow checks each against its port).
- `<name>-node/`: a local node's files (`swarm-node`, `ipfs-node`). The IPFS node is the build of the public
  `orivon-ipfs-node` repository's workflow (`orivon-wasm.yml`); a new pin names the CID of that build's folder.
- [`nym-tunnel/`](nym-tunnel/): Nym's mixnet client as WebAssembly, the built-in tunnel for installed apps. Built
  from Nym's source with one patch (`vendor/nym-smolmix/`).

A node's or the tunnel's folder holds only its manifest (`<name>.json`: the IPFS directory's CID and each file's size
and sha256) in git. `scripts/fetch-local-nodes.mjs` fetches the files it pins into the same folder, which git ignores,
and the browser runs only files that match. `ORIVON_<NAME>_DIR` (`ORIVON_NYM_TUNNEL_DIR`) names a local directory to
copy them from instead.

`electron-builder.yml` copies each folder here into the package's resources folder (`extraResources`); a run from
source reads them from this checkout.

**What it depends on.** Nothing: it holds data.

**What it must never contain.** Code, or a file fetched at install time that is not gitignored.
Fetched files go in a folder git ignores, and the script that fetches them names its pin
(`default-profile/bundled-extensions.json`).
