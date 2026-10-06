# `src/telemetry/`: measurement, consent and its disclosure

**What lives here.** Event collection, session accounting, sending, and the decidable part of the
two screens [`ADR-0004`](../../docs/decisions/ADR-0004-telemetry.md) makes non-optional: the
disclosure and the "what has been sent" page. [`ADR-0063`](../../docs/decisions/ADR-0063-telemetry-v2.md)
holds the payloads, the identity and the consent rule; [`docs/privacy/notice.md`](../../docs/privacy/notice.md)
is the text people read, and its field table is compared with the payload types by a unit test.
[`testing.md`](../../docs/development/testing.md) §6 says why the accounting is a pure fold with
its own tests.

The screens exist. The first-run welcome has a **Telemetry** checkbox (unticked when the time
zone is in Europe, ticked elsewhere; hidden once a choice is stored). Settings has the switch,
the literal text of both messages, the history of what was sent, the install ID, **Delete my
data**, and the notice.

**What runs, and when.** Telemetry starts only in `npm run start` and packaged builds, outside a
private window, and with `ORIVON_TELEMETRY` not set to `off`. A development build (`npm run dev`),
a private window and an `off` run start nothing: no measuring, no machine-ID read, no send. The
e2e launch helper sets `off` and a temporary telemetry home unless a spec opts in.

**Identity and consent are per computer and per operating-system user, not per profile.** The
consent file and, only where the machine ID cannot be read, a fallback ID live in
`<appData>/orivon-telemetry/` (a test build uses its own temporary home). Every profile process
reads the consent fresh on each send tick, so one switch governs them all. The install ID is a
keyed one-way hash of the operating system's machine ID, computed after consent; each profile
keeps its own accounting, history, queue and random `stream` under its own data directory, so
two profiles open together are both counted and summed as one computer on the server.

**Two messages and an erase.** A usage report (install ID, stream, region from the time zone,
version, month, active and background seconds, seconds per site class) and an unlinked site
report (a random monthly report ID and seconds per named Web3 or Web2.5 site) go to
`telemetry.orivonstack.com`, each at most once a day as a month-to-date total the server
upserts. The erase request carries the install ID. The client ignores every response body.

**Mostly durable.** `accounting.ts`, `disclosure.ts`, `transport.ts` and `history.ts` are pure;
`runner.ts` wires them to Electron, and `store.ts` to disk.

**What it depends on.** [`src/contracts/`](../contracts/), [`src/trust/website-level.ts`](../trust/website-level.ts)
for the site class, and type-only [`src/main/registry.ts`](../main/registry.ts) for the
`Subsystem` that `runner.ts` exports.

**What it must never import.** [`src/broker/`](../broker/) internals.

**Owner stream.** `telemetry`, build step 8.

## Design notes

**`accounting.ts`'s `applyEvent` runs one event at a time in [`runner.ts`](runner.ts)**, which
persists `AccountingState` periodically, so a crash loses minutes, not a session. The
`'checkpoint'` event gives it that moment during a silent stretch, such as hours of background
seeding with no focus change. The site classes and per-site seconds are a second dimension of
the same fold: the seconds credited to the focused window's active tab go to its site key, and
the sum over the site keys equals the shell's `activeSec` for the same events.

**A Web2 site is never named, anywhere.** Only its class total exists, so there is nothing to
leak from disk or from a message. A Web3 or Web2.5 site is named only when its name is public (a
domain, an ENS name, or a site the Web3 Score provider judged); anything else is added to the
class and sent as `(unlisted)`.

**[`store.ts`](store.ts) does not debounce, unlike `BookmarkStore`.** Accounting state changes
with time, not with clicks, so a debounce would mean a write after every event. Accounting and
history are written at `checkpoint()`; the consent, a discrete decision a crash must not lose,
is written at once.

**[`transport.ts`](transport.ts) sends one aggregate payload per period, never one per event**:
`attemptSend` only ever sees a payload, never a `TelemetryEvent`. **`MAX_QUEUE_SIZE` is 1**
because ADR-0004 forbids a backlog that reconstructs the timeline; because the snapshot is a
month-to-date total the server upserts, a device offline for a day loses nothing, and one
offline across a month boundary loses the older period's closing snapshot.

**The machine ID is read only after consent, and only through injected readers.** Deriving the
ID and parsing the platform's output are pure and unit-tested; the readers (a file on Linux,
`ioreg` on macOS, `reg query` on Windows, run with no shell and a short timeout) are passed in.

**A stored acceptance carries the `NOTICE_VERSION` it was given under.** When the constant
differs, the consent reads as undecided and the welcome checkbox appears again. Bump it with any
change to a payload or to `docs/privacy/notice.md`.
