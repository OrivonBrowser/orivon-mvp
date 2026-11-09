# `src/main/diagnostics/`: the browser's record of its own health, and the bug report

**What lives here.** What Orivon keeps on this computer about its own crashes, and the report a person may send
about one. `log-ring.ts` and `log-file.ts` keep the main process's console output (newest 1000 lines in memory,
`logs/current.log` on disk), and with it every line Orivon's utility processes print: `host-output.ts` turns a host's
piped output into console lines and `host-fork.ts` forks every host that way; `crash-records.ts` and `crash-store.ts` the crash records (`crashes.json`, newest 30,
dropped after 30 days) and the run marker (`running.json`) that says whether the last run ended in an orderly quit;
`dumps.ts` and `dump-files.ts` the native crash dumps Crashpad leaves; `diagnostics-service.ts` composes them for one
run. The report: `diagnostics-facts.ts` shapes the `diagnostics` block, `gpu-reading.ts` parses what Chromium reports about the graphics setup (the feature map, the device list and the names of a device) for every reader of it, `webgpu-state.ts` says whether WebGPU works and why not (the block carries its state and reason code; `orivon://gpu` shows its sentence; the block also carries the WebGPU question's default and how many sites are allowed and blocked for it, counts only, `siteAnswerCounts`), `report-payload.ts` builds the body and cuts
every field to the length the server accepts, `report-text.ts` writes the Markdown for "Copy as text",
`report-channel.ts` posts and reads the status, `sent-reports.ts` keeps the list of what was sent, and
`report-domain.ts` is what [`orivon://report`](../../renderer/pages/report/) may ask. `diagnostics-runner.ts` and
`report-runner.ts` connect all of it to Electron. Everything is under `<userData>/diagnostics/`, so a private
session's copy is removed with its directory.

**Tied to Electron, in the two runners and `host-fork.ts`.** `diagnostics-runner.ts`, `report-runner.ts` and `host-fork.ts` import `electron`; the rest
is pure, or reads and writes plain files, and runs under plain vitest.

**Durable: `gpu-reading.ts` and `webgpu-state.ts`.** `webgpu-state.ts` is a pure function over the platform, the desktop session, the Ozone platform, Chromium's feature statuses and the graphics devices (as `gpu-reading.ts` parses them), and takes the page's adapter result, what the WebGPU-on-X11 setting did in this run, whether the window is private (where that setting's switch is locked), and whether the WebGPU default for sites is Block (so that its X11 sentence does not say a site is asked), as arguments; a report's page (`orivon://report`) asks for an adapter as the Graphics tab does and sends the outcome with its request for the facts. Its reasons are Chromium's own, so they change with a Chromium update (`docs/planning/webgpu-plan.md`); the names it matches (`webgpu`, `gpu_compositing`) are the ones `app.getGPUFeatureStatus()` returns. On Linux it decides by the Ozone platform and does not read `webgpu_on_vk_via_gl_interop`, which reads enabled on real graphics cards where no adapter exists. Reading those values is tied to Electron and done in `../info/about-runner.ts` and `report-runner.ts`.

**What it depends on.** `electron` (the runners); [`../pages/`](../pages/) (the internal-domain type, the page ids);
[`../shell/`](../shell/) (the window registry and the shell scheme, types and one constant, and `tab-tunnel-facts.ts`'s counts of the tabs' tunnel choices, which reach `../route/` for the choice names); [`../settings/`](../settings/)
(the setting names, to pick which ones a report states); [`../graphics/`](../graphics/) (`x11-vulkan-runner.ts`'s reading of what the WebGPU-on-X11 setting did in this run and its one answer to which Ozone platform Orivon draws through, which `report-runner.ts` hands to the report; `x11-vulkan.ts`'s rule for where the setting is offered and its reading type, which `webgpu-state.ts` and `diagnostics-facts.ts` use); [`../../telemetry/mode.ts`](../../telemetry/mode.ts) (where
reports go, and the test-build override); [`../../broker/adapters/atomic-write.ts`](../../broker/adapters/atomic-write.ts) (the write that lands whole or not at all); [`../registry.ts`](../registry.ts) (the `Subsystem` type); [`../sessions/network-service-restart.ts`](../sessions/network-service-restart.ts) (`isNetworkServiceEnd`, which tells the network service's end from another process's, since Orivon never ends that one itself, and `RestartCounts`, the shape of the restart counts a report states) and [`../sessions/network-service-hold.ts`](../sessions/network-service-hold.ts) (the process's one hold, whose counts `report-runner.ts` reads); [`../route/proxy-mirror/mirror-status.ts`](../route/proxy-mirror/mirror-status.ts) (whether the system's proxy settings are copied into the sessions, and why not, as fixed words); [`../../protocols/verifier-host/light-client/endpoint-mask.ts`](../../protocols/verifier-host/light-client/endpoint-mask.ts) (`MASK`, the one mask every shown address and every scrubbed secret goes through, which `secret-scrub.ts` imports and nothing else of the host).

**What it must never import.** [`../../renderer/`](../../renderer/), and anything that could reach the person's
files, passwords or browsing: a report is built from the facts passed to it, never from a store read here.

**Owner stream.** `shell`.

## Design notes

**What a utility process prints is main's log.** A host forked with Electron's default output would print past main, to the app's own
stderr: in a terminal that is seen, but a packaged Windows app has none, and no report could hold it. `hostForker` forks the
verifier host, each local node's host and the Nym tunnel's host with `stdio: 'pipe'` and `HostLog` writes each line to main's
console as it arrives, so it passes through the same `scrub`, ring, file and redaction as any line of main's, and from a terminal it
still appears once, written by main. A host's stdout is written at `log` and its stderr at `warn`, so a `console.error` of a host
reads as a `WARN` line; a line that does not begin with the host's own tag (`[verifier]`, `[ipfs-node]`, `[swarm-node]`,
`[nym-tunnel]`) gets it put in front, and an indented line stays under the line before it. A line is not cut before the scrub: a
key main has noted can straddle the length the ring keeps, so the scrub sees the whole line and `logLines` cuts after it (only a
line that never ends is written in pieces, at four times that length, so memory does not grow). A last line with no newline is
written when its stream ends, not when the process exits: Electron ends the streams itself and output can still be in the pipe at
`exit`, so a crash line split across reads stays one line; a stream still open 2 s after the exit is read as ended. The pipe is
always read to its end: a host whose pipe nobody empties stops. A host's lines tell no more than main's: the light client's are
cleaned in the host of the servers the person typed, the scrub covers any key main has noted, the home folder becomes `~` in a
report, and the rest are counts, durations, sizes, the host names of Orivon's own gateways, or the text of an unexpected failure,
which can name a page or a file, as the report says of any line (main's name origins and host names too). The Nym tunnel's host is
the one that also runs code that prints what it likes, and is treated apart (below). A private session's log, with them, goes with
its directory.

**A host's lines are collapsed and capped for the log's sake.** A line a host prints again and again, such as the light client's
refresh failure at every retry, is written once; the identical lines after it (same stream, same text, a stack counting as one) are
counted, and one line says "the line above repeated N times" when a different line comes, when the minute ends or when the app
quits, so a failure that never changes costs two lines a minute instead of twelve. Repeats do not count against the allowance; the
line that counts them does, and is never refused. A host keeps at most 60 lines a minute written as they come, shared by its two
streams and by every process it is forked as. At the first line past that, one marker line says so at once ("more than 60 lines this
minute"); the rest are counted, the last 5 entries of them are kept, and when the minute ends they are written with the count, so
the lines nearest a failure are in the log even when a flood came before them. It bounds the 1000-line ring against a host that
loops, so a few minutes of main's own lines are not pushed out by one host. An entry (a stack) is never cut. `hostForker` has
`HostLog.flush()` run on `will-quit`, from a listener placed ahead of this folder's own, which writes the log file out and ends the
run: what a host held back is then in the file, not lost with the process. A host whose switch (`ORIVON_VERIFIER_LOG`,
`ORIVON_IPFS_NODE_LOG`, `ORIVON_SWARM_NODE_LOG`, `ORIVON_NYM_TUNNEL_LOG`, each `=1`) is on is neither collapsed, capped nor
filtered: a developer running from a terminal sees everything the host prints. The 60 is *provisional*. A host writes mainly one
line per site mounted, one per file of 256 KiB or more and one per failure, so only a failure flood reaches 60 a minute.
Measured on a source run of the Swarm end-to-end spec (six Swarm sites mounted and one large file read in 13 s), the verifier host
wrote 6 lines, 4 of them within one second, beside 3 of main's own; the smoke run, which loads no `.eth` name, made it write none,
and the IPFS node, Swarm node and Nym hosts ran in neither. A real person's log would settle the number.

**The Nym tunnel's host writes only its own lines to the log.** The WebAssembly library the host runs passes its own strings to
`console.error` and `console.warn`, and they can name where a Nym-routed app connects, which is what Nym exists to hide. Every line
the host's own code writes begins with `[nym-tunnel]`, its unhandled-rejection handler included; `HostLog`'s `onlyTagged` counts
the others and leaves them out, and one line a minute says how many came "from the Nym library". What Node prints itself when the
host crashes carries no tag and is left out as well: the supervisor reports the exit and its code. This is a `HostLog` option, not
Nym code here, so another host that runs a library can ask for it.

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

**The redaction is the home directory and the secrets main has noted.** `~` replaces the home directory in every string
sent and in the preview. A username elsewhere (a path under `/Users` of another account, a name in a page address) is not
found by it, which is why the page address is a box that is off by default. [`secret-scrub.ts`](secret-scrub.ts) keeps what
main has told it is a secret (today the parts of the Ethereum server addresses the person typed, which may hold a key) with
what shows in its place; `DiagnosticsService.log` and `record` apply it to a line and a crash before they keep it, and
[`report-payload.ts`](report-payload.ts) applies it to every field before a field is cut, so a secret cut in two by a limit
cannot survive half. Text of the person's that no one told it about, a secret under four characters and a page's own
content are not covered.

**WebGPU is ruled out here, never ruled in.** Main cannot ask for an adapter, so [`webgpu-state.ts`](webgpu-state.ts) answers `available` only when a page reports that it got one (the About page does). With no page, a computer where Chromium shows no block reads `unknown`, in a report too. A reason is given only when the inputs show it: a missing device list is not "no graphics card", an unnamed Ozone platform is not an X11 session, and a Windows computer is never called software-only because its software renderer (WARP) is a device Chromium accepts. When more than one reason holds, the one that holds on any session comes first (pages drawn in software), then the session or maker, then Chromium's own "off". The entry sits in the report's `gpu` group beside the features, and survives the shrink step that drops the features: it is the short form of them. On X11 the run's own reading of the WebGPU-on-X11 setting decides what is said: with the switches on, X11 is not blamed for every card and only a page that got no adapter says Vulkan found none (`x11-vulkan-no-adapter`); a revert Orivon recorded is the reason, before the processor check, because a bad run is what leaves pages drawn there (`x11-vulkan-reverted`). The report carries the setting's value at the start and the revert's time and word under `gpu.x11Vulkan`.
