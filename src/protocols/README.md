# `src/protocols/`: the ways a site is found and loaded besides DNS and HTTP

**What lives here.** Everything that turns a name Chromium cannot load by itself into a page:
the provider interfaces, each protocol behind them, and the process that serves their pages.

| Folder | Holds | Tied to Electron? |
|---|---|---|
| [`resolution/`](resolution/) | The `NameResolver` and `DataGatherer` interfaces, their records and failures, and the fallback rule that orders providers | **No** |
| [`ens/`](ens/) | Proving a `.eth` name's contenthash through ENS, over any EIP-1193 provider | **No** |
| [`ipfs/`](ipfs/) | Loading IPFS content from trustless gateways, every block hashed against its CID | **No** |
| [`verifier-host/`](verifier-host/) | The utility process that runs every protocol's providers and serves their pages on loopback | **Entirely** |

**What it depends on.** Each folder's own `README.md` says. None of them imports
[`src/main/`](../main/) beyond type-only imports; [`src/main/verifier/`](../main/verifier/) is the
shell's side, and talks to the verifier host only over its message protocol.

**Owner stream.** `ens-ipfs`.
