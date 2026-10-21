# `src/main/diagnostics/`: the browser's record of its own health, and the bug report

**What lives here.** What Orivon keeps on this computer about its own crashes, and the report a person may send
about one. `log-ring.ts` and `log-file.ts` keep the main process's console output (newest 1000 lines in memory,
`logs/current.log` on disk); `crash-records.ts` and `crash-store.ts` the crash records (`crashes.json`, newest 30,
dropped after 30 days) and the run marker (`running.json`) that says whether the last run ended in an orderly quit;
`dumps.ts` and `dump-files.ts` the native crash dumps Crashpad leaves; `diagnostics-service.ts` composes them for one
run. The report: `diagnostics-facts.ts` shapes the `diagnostics` block, `report-payload.ts` builds the body and cuts
every field to the length the server accepts, `report-text.ts` writes the Markdown for "Copy as text",
`report-channel.ts` posts and reads the status, `sent-reports.ts` keeps the list of what was sent, and
`report-domain.ts` is what [`orivon://report`](../../renderer/pages/report/) may ask. `diagnostics-runner.ts` and
`report-runner.ts` connect all of it to Electron. Everything is under `<userData>/diagnostics/`, so a private
session's copy is removed with its directory.

**Tied to Electron, in the two runners.** `diagnostics-runner.ts` and `report-runner.ts` import `electron`; the rest
is pure, or reads and writes plain files, and runs under plain vitest.

**What it depends on.** `electron` (the runners); [`../pages/`](../pages/) (the internal-domain type, the page ids);
[`../shell/`](../shell/) (the window registry and the shell scheme, types and one constant); [`../settings/`](../settings/)
(the setting names, to pick which ones a report states); [`../../telemetry/mode.ts`](../../telemetry/mode.ts) (where
reports go, and the test-build override); [`../../broker/adapters/atomic-write.ts`](../../broker/adapters/atomic-write.ts) (the write that lands whole or not at all); [`../registry.ts`](../registry.ts) (the `Subsystem` type).

**What it must never import.** [`../../renderer/`](../../renderer/), and anything that could reach the person's
files, passwords or browsing: a report is built from the facts passed to it, never from a store read here.

**Owner stream.** `shell`.

## Design notes

**A report leaves only when the person presses Send.** Nothing here sends on its own, and `ORIVON_TELEMETRY=off` and
the telemetry consent do not govern it: it is the person's own act, with its own preview. The page never assembles
what is sent. `report-domain.ts` builds the body from the choices on the form, shows that same body as the preview
(the dump as its size), and posts it, so the two cannot differ. The facts and the log are taken once when the page
asks for its state and kept for that page, because a clock reading that changed between preview and send would make
the preview not the report.

**The report ID is reused only for the same text.** A failed send keeps its ID, so a retry of the same report is
counted once by the server (a repeated ID answers 204 and stores nothing). Changed text gets a new ID, because the
server would otherwise drop the edit as a repeat.

**Native dumps stay on this computer.** `crashReporter.start({ uploadToServer: false })` runs in the `diagnostics`
subsystem's `beforeReady`. Measured on Electron 44 on Linux (a main-process `process.crash()` and a
`forcefullyCrashRenderer()`): `app.getPath('crashDumps')` is `<userData>/Crashpad`, so it follows the profile's own
directory and a private session's; a dump is `Crashpad/pending/<uuid>.dmp` with a `<uuid>.meta` beside it (about
250 KB for the main process, 110 KB for a renderer), and with uploads off it stays in `pending` (`completed/` stays
empty). Its modification time is the moment of the crash. `dump-files.ts` also reads `completed/` and `reports/`, where
macOS and Windows keep theirs, which has not been measured here. A dump belongs to the crash record written within
60 seconds of its modification time; a main-process native crash leaves no record of its own, so the next start writes
an `unclean-exit` record dated at the dump. The newest 10 dumps are kept and any older than 30 days are deleted at
every start. A dump goes into a report only when the person ticks its box, at most 5 MiB.

**An unclean exit and a fatal error are one event.** The marker is removed at `will-quit`, so `app.exit()` and a crash
leave it behind. A fatal error (`start.ts` calls `recordFatal` before `app.exit(1)`) already wrote a record, and the
next start does not add an unclean-exit record for the same run. A renderer crash does not count: it says nothing
about whether the browser itself ended well.

**The redaction is the home directory and nothing else.** `~` replaces it in every string sent and in the preview. A
username elsewhere (a path under `/Users` of another account, a name in a page address) is not found by it, which is
why the page address is a box that is off by default.
