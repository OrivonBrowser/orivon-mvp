# Main-process APIs: `MessagePortMain` and the clipboard

## `MessagePortMain` fails by silence, not by error

Measured directly (`docs/planning/spike-results/gate-0.json`): passing an `ArrayBuffer` in the transfer list of
`MessagePortMain.postMessage` **renderer to main** does not throw and does not corrupt the payload. **The message never
arrives, at all**, for any size tested. This reproduces [electron#34905](https://github.com/electron/electron/issues/34905),
and the real behaviour is worse than the issue as filed.

**Consequences, both load-bearing:**
- **Never design a reply-carrying protocol over `MessagePortMain` without a timeout.** A reply promise with no timeout
  hangs indefinitely, waiting for a message that was already silently dropped.
- **Do not reach for transferables as a throughput optimisation on this path.** They are not available. Structured
  clone (which copies) is not a fallback for a rescue plan: it is the *only* mechanism, and it is fast enough on its
  own: 313-1134 MB/s measured, against a 1-5 MB/s product requirement.

The durable form of these lessons is `docs/architecture/capability-api.md` sections Design rules and Throughput, and
`docs/architecture/handle-contracts.md` section What the shim must do.

## The main-process clipboard writes answer promises, and `write` can reject

Electron 44's `electron.d.ts` types `clipboard.writeText` and `clipboard.write` as `Promise<void>`, and the source says
the same (read at the `v44.7.0` tag: `lib/browser/api/clipboard.ts` and `shell/browser/api/electron_api_clipboard.cc`;
not run).

- `write` is an `async` function. It rejects with a `TypeError` for anything but an array of `ClipboardItem`, and
  awaits every item's `Blob` before one native commit, so a failure arrives as a rejection.
- `writeText` is the native binding itself. It writes before it answers, and the promise it returns is already
  resolved, so it never rejects; a non-string argument throws at the call.

`src/main/start.ts` ends the browser on an unhandled rejection, so `await` the result of `write` (which is right
whichever way a version behaves), never leave it floating, and never `.catch` the raw return of either. A thrown call
inside an `async` function is a rejection too. `check:floating-promises` flags a floating `write` and allows
`writeText`. A spec that replaces either method with a recorder makes it `async` like the real one: a stub that
returns nothing makes a `.catch` on the result throw, which says nothing about Electron. Under this machine's xvfb a
main-process clipboard call can also hang, so a spec checks what the person sees (a toast, a returned outcome), never
a clipboard round trip.
