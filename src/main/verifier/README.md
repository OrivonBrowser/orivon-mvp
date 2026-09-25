# `src/main/verifier/`: the shell's side of the `.eth` verifier

**What lives here.** Everything the main process does for `.eth` names: the resolver rules that
send every `.eth` host to the verifier's loopback port, the certificate check each session applies,
starting and restarting the verifier host ([`../../verifier-host/`](../../verifier-host/)), choosing
the light client's checkpoint, keeping what the host verified between runs, and saying in words
what the light client is doing and how a `.eth` name led to the page a tab shows
([`name-evidence.ts`](name-evidence.ts), for the site-info popover). It also stamps every page's
`.eth` request with the top-level page origin it belongs to ([`partition.ts`](partition.ts)), so
the verifier keeps one cache per site.

**Tied to Electron.** Disposable. [`verifier-subsystem.ts`](verifier-subsystem.ts) is the one file
that imports `electron`; the rest are decisions, unit-tested under plain vitest, on this
directory's `<name>.ts` / `<name>-subsystem.ts` convention ([`../README.md`](../README.md)).

**What it depends on.** [`../../verifier-host/protocol.ts`](../../verifier-host/protocol.ts) for the
messages it exchanges with the host, [`../dev/eth-resolver.ts`](../dev/eth-resolver.ts) for this
run's developer names, the broker's atomic file write and pin types
([`../../broker/policy/pin.ts`](../../broker/policy/pin.ts)), the loader's test for a `.eth` origin
([`../../loader/fetch/eth-origin.ts`](../../loader/fetch/eth-origin.ts)), and the pointer-chain verdict and
Website level types ([`../../resolution/`](../../resolution/), [`../../trust/`](../../trust/)).

**What it must never import.** The verifier host's code, as opposed to its protocol types: it runs
in another process, and only [`host-supervisor.ts`](host-supervisor.ts) talks to it.

**Owner stream.** `ens-ipfs`.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment warns about a trap a maintainer would otherwise fall into, and the argument for
a design belongs here instead.

**The partition stamp is on the default session only** ([`verifier-subsystem.ts`](verifier-subsystem.ts)'s
`installPartitionStamp`). Any `webRequest` listener sends every request of its session through
Electron's proxy, and with it a redirect a `protocol.handle` handler returns reaches the page
with the redirect's status on the final response (`test/e2e-served-csp.test.ts` measures it).
Installed apps and web contexts serve `https` through such handlers, so a listener there would
break every routed redirect. None of their pages reaches the verifier anyway: their handlers
dial through Node's `https`, which cannot resolve a `.eth` name. Every page that can reach it, a
`.eth` page included, runs in the default session.

**One owner of `--host-resolver-rules`** ([`resolver-rules.ts`](resolver-rules.ts)). A second copy of
the switch replaces the first, and the first matching `MAP` clause wins. So one value is built, in
this order: developer-mode names, then `MAP *.eth 127.0.0.1:<port>`, then whatever the command line
already carried, which is how a test run's hermetic rules survive.

**The port is chosen before ready, synchronously** ([`loopback-port.ts`](loopback-port.ts)). The
switch must be set before Electron is ready, and a subsystem's `beforeReady` cannot wait. Only a
bind with no host is synchronous in Node, so for about a millisecond the probe listens on every
interface with no handler before closing. The host binds the port later; if something took it in
between, that bind fails and Settings says so.

**A `.eth` certificate is judged by fingerprint only** ([`certificate-check.ts`](certificate-check.ts)).
The name inside the certificate decides nothing; the run's fingerprint does, and until the host
reports one every `.eth` host is rejected. Every other host keeps Chromium's own verdict. The check
goes on every session through `session-created`, because a partition without it fails.

**The host starts after the first page loads** ([`verifier-subsystem.ts`](verifier-subsystem.ts)).
The spike measured no delay to the first window either way, so this is a margin, with a three-second
fallback for a start where no page loads.

**Every request to the host has a deadline** ([`host-supervisor.ts`](host-supervisor.ts)). A
utility process's port fails by silence, not by error, so a reply that never comes is the failure
to expect. A host that exits rejects every pending request and restarts with backoff, from one
second to one minute, reset after a minute's stable run.

**The checkpoint is Orivon's choice, not the light client's** ([`checkpoint.ts`](checkpoint.ts)).
Helios enforces no age and silently replaces a malformed checkpoint with one compiled into it. So
the shell takes the newer of the release's and the last one this install verified, refuses any
past 14 days, and the store keeps only a newer one. `scripts/refresh-eth-checkpoint.mjs` refreshes
the release's from two beacon APIs that must agree.

**A dead verifier outranks everything in the status** ([`status-view.ts`](status-view.ts)). With it
down no `.eth` page loads at all, fixture names included, so "not running" wins over "switched off".
