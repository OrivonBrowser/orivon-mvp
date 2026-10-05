# `docs/planning/compatibility/`

The rows of the compatibility matrix's Tables 1, 2, 3 and 5, one file per sub-table.
[`../compatibility-matrix.md`](../compatibility-matrix.md) holds the same tables in readable form,
one row per topic, with the legend and Tables 4 to 8. These pages list every item one by one, each
checked against the code, for looking up a single module, member, permission or protocol.

These pages follow the rule the matrix follows ([`CLAUDE.md`](../../../CLAUDE.md) Rule 2), although
they sit under `planning/`: each says what works today and nothing else. A row changes when the
code does, in the same pull request, and so does the readable row that sums it up on the matrix
page.

What a working app relies on, behaviour by behaviour and each tied to the end-to-end spec that
proves it, is [`../../development/app-behaviours.md`](../../development/app-behaviours.md).

| File | Table |
|---|---|
| [`table-1-capabilities.md`](table-1-capabilities.md) | 1a, what `orivon.*` offers; 1b, authority no capability covers |
| [`table-2a-node-modules.md`](table-2a-node-modules.md) | 2a, Node's standard library, module by module |
| [`table-2b-electron.md`](table-2b-electron.md) | 2b, the `electron` module; 2c, packages that wrap Electron; 2d, web-ecosystem providers |
| [`table-3a-globals-and-process.md`](table-3a-globals-and-process.md) | 3a, globals and `process` |
| [`table-3b-modules-and-delivery.md`](table-3b-modules-and-delivery.md) | 3b, module system, bundling and delivery |
| [`table-3c-files.md`](table-3c-files.md) | 3c, files (`fs`, `path`, `os`) |
| [`table-3d-network.md`](table-3d-network.md) | 3d, network (Node modules and the page's routed APIs) |
| [`table-3e-crypto-compression-buffers.md`](table-3e-crypto-compression-buffers.md) | 3e, crypto, compression and buffers |
| [`table-3f-streams-events-utilities.md`](table-3f-streams-events-utilities.md) | 3f, streams, events, utilities, timers, assert |
| [`table-3g-running-code.md`](table-3g-running-code.md) | 3g, running code (processes, threads, `vm`, WebAssembly, native addons) |
| [`table-3h-the-page.md`](table-3h-the-page.md) | 3h, the page (origin, served policy, storage, workers, frames) |
| [`table-3i-windows-and-lifecycle.md`](table-3i-windows-and-lifecycle.md) | 3i, windows, lifecycle and the desktop around the app |
| [`table-3j-permissions-devices-secrets.md`](table-3j-permissions-devices-secrets.md) | 3j, permissions, devices, identity and secrets |
| [`table-3k-protocol-stacks.md`](table-3k-protocol-stacks.md) | 3k, protocol stacks, by the primitive each needs |
| [`table-5-native-modules.md`](table-5-native-modules.md) | 5, native packages and what stands in for each |

Each file is long. Search it (`grep -n`) for the module, member, permission or protocol you
need rather than reading it whole.
