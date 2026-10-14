# `src/main/networks/`: the Available networks popup

**What lives here.** What the toolbar's Available networks button shows and does: a card for each node Orivon runs
on this computer (the Ethereum light client, the IPFS node, the Swarm node, the Nym tunnel), with a status word, a switch,
one sentence on what the node does for the person, and the figures known of it. Five files, from the facts to the window:

| File | What it is |
|---|---|
| `networks-view.ts` | pure: the facts of the four nodes in, the cards and the toolbar dot out (statuses, notes, figures, the colour of the dot) |
| `networks-source.ts` | gathers the facts from injected sources, builds the view, and moves a card's switch by the setting Settings uses for the same thing; Electron-free |
| `nym-watch.ts` | Nym as the popup reads it: joins the routes' Nym on the first read or subscription that finds the routes published, so a subscription made earlier is not lost; Electron-free |
| `networks-runner.ts` | the one file that touches live things: the verifier, the two nodes, Nym and `app.getAppMetrics()` |
| `networks-panel.ts` | the popup, on `../permissions/popover-view.ts`, with its IPC (`../ipc/networks-ipc.ts`) |

**Tied to Electron.** `networks-runner.ts` and `networks-panel.ts` import `electron`; the other three are pure and run under
plain vitest.

**What it depends on.** [`../verifier/`](../verifier/) (the light client view, the node subsystems, the traffic the
verifier host counted, process info), [`../route/`](../route/) (Nym's state, tunnels and process, as types and through
`ctx.routes`), [`../settings/`](../settings/) (the store and the keys), [`../permissions/popover-view.ts`](../permissions/popover-view.ts),
`../ipc/networks-ipc.ts`, `../shell/theme-colors.ts`, [`../../protocols/local-node/`](../../protocols/local-node/) (types).

**What it must never import.** The broker, the loader, or anything that opens a connection: it reads what the nodes
report and writes a setting, nothing else.

**Owner stream.** `shell`.

## Design notes

**A card's switch writes the setting Settings uses, and nothing else.** The light client is `web3.lightClient`, the IPFS node
`web3.ipfsSource` (`node` or `gateways`), the Swarm node `web3.swarmNode` and Nym `network.nym.enabled`. The node itself
follows the setting through the same listener whichever door the change came from, so the popup and Settings never disagree.
A switch that cannot move is disabled with its reason on the card: the light client while the run was started with it forced
off, and Nym while the tunnel is the person's own SOCKS5 address.

**Nodes start when a page needs them and sleep after ten minutes, and the card says so.** A node that is on and not running
is `Asleep`, never `Off`: `Off` is the person's switch, or a reason (the whole browser goes through the tunnel, a test build
serves the content itself), and the reason is on the card.

**The dot counts only what the person switched on.** Red when such a node failed, amber while one starts or syncs, green while
one runs, nothing otherwise. It reaches the chrome through `ShellState` (`../shell/state/networks.ts`), from memory, so a
push never measures a process.

**Nothing polls while the popup is closed.** The popup's IPC subscribes to the source and starts a two-second timer for the
figures when it is built, and stops both when the popup is destroyed. Memory and CPU come from `app.getAppMetrics()`, matched
by the process id the supervisor holds, or by service name when it has none; CPU is absent until a second reading.
