# `src/main/startup/`: what a start opens

**What lives here.** The plan for a cold start and the offer that follows a crash. `startup-plan.ts` turns
the start-up choice (`startup.mode`, `startup.pages`), the addresses on the command line (web addresses and local files) and the previous
session into what the first window opens and which windows follow, and says whether any of it is a local file, so that the launch
reads the binary's file-protocol fuse before the window exists (`planOpensLocalFile`), and says whether a start brings the saved session back (`startupRestoresSession`, which a restart offer elsewhere asks before it names a page). `startup-open.ts` carries that out
(tabs, display-aware placement, taking reopened windows off the closed stack). `startup-domain.ts` answers the
Settings page's two questions about the pages list. `restore-offer.ts` and `restore-overlay.ts` are the bar
that offers the last session back after a run that did not end cleanly, and the report of that crash ("Report the problem", from `../diagnostics/crash-lookup.ts`), which it also offers when nothing is left to restore; `startup-overlays.ts` wires it to the
real displays. `fetch-stack.ts` loads Node's `fetch`/`Response` implementation before any hook or window exists, so a debugger command cannot arrive in the middle of its lazy load. `startup-marks.ts` records named moments of a start in milliseconds since the operating system created the process, and defines the one line a start prints and the record a problem report carries; `startup-marks-runner.ts` is the process's one set of them on the real clock, imports no `electron`, and loads nothing, so `../start.ts` may import it ahead of the lock. `web-ready.ts` is the gate on web pages: no tab, navigation or wake of a sleeping tab loads a page of the web until the start has routed every session and loaded every enabled extension, and what asks earlier waits and runs, in order, when `index.ts` opens it (`deferUntilWebReady`); the shell's own pages never wait. `web-ready-test-seam.ts` is its test-build hook.

**Tied to Electron, partly.** Only `startup-overlays.ts` imports `electron`; the rest takes plain values and
structural types, so it runs under plain vitest. `startup-marks-runner.ts` reads Electron's `process.getCreationTime()` and falls back to the performance clock where it is absent. The gate in `web-ready.ts` is durable: it has no Electron in it, and what must wait calls it.

**What it depends on.** [`../diagnostics/`](../diagnostics/) (`crash-lookup.ts`); [`../session-restore/`](../session-restore/) (the saved session, `openSnapshot`,
`fillTabs`, the closed stack), [`../window-state/placement.ts`](../window-state/placement.ts),
[`../browsing/omnibox.ts`](../browsing/omnibox.ts) (which addresses load), [`../settings/`](../settings/),
[`../overlays/`](../overlays/) and the window-hook types of [`../shell/`](../shell/).

**What it must never import.** [`../../renderer/`](../../renderer/) code, or anything that creates a window:
the launch hands it `openWindow`.

**Owner stream.** `shell`.

[`DESIGN.md`](DESIGN.md) holds why the gate is on making tabs and not on requests.

## Design notes

**The command line is added to the choice, never replaced by it.** A person who clicked a link wants that page
in front; the restored or listed tabs stay behind it. A private session ignores the choice altogether: it is a
browser of its own, so it neither restores the last session nor is offered it.

**Both the list and the session file are data, and are read again at launch.** `startup.pages` is
re-validated line by line with the address bar's own rule (`parsePages`), and the session's tabs go through
`openSnapshot`, which checks each address once more. Nothing from either reaches the trusted opening path.

**The previous session's windows are on the closed stack already.** When the launch reopens them, or the bar's
Restore does, they are taken off it, so "Reopen closed tab" never offers the same windows twice.

**Restored tabs load at once.** This build has no deferred loading of background tabs, so a session of thirty
tabs loads thirty pages at start.

**The bar never takes focus and is answered with the mouse.** Main keeps the keys so a person typing is not
interrupted; the bar leaves by itself after thirty seconds.

**A start can be profiled, and the profile ends with the start-up line.** `ORIVON_STARTUP_PROFILE=<file>` makes `startup-profile-runner.ts` (imported first by `../start.ts`, so its evaluation starts the profile before the other imports are evaluated) run V8's sampling profiler on the main process through `node:inspector` and write a `.cpuprofile` to that file when the start-up line prints, or after 20 s if it does not; with the variable unset it reads one variable and loads nothing. It works in a packaged build, and a failure is one `[orivon][startup-profile]` log line, never a failed start. `startup-profile.ts` is durable: the start and stop logic over an inspector, a file writer and a clock passed in. The runner is tied to Node's `node:inspector` and, for the profile's place on the start-up line's clock, to Electron's `process.getCreationTime()` (the performance clock stands in without it). The runner knows nothing of the marks and the marks know nothing of the profiler: `../start.ts` hands `stopStartupProfile` to `onStartupLine` in `startup-marks-runner.ts`. The sampling interval is fixed at 250 us rather than a setting, finer than V8's 1 ms so a function of a few milliseconds shows in a stretch of a few hundred, and a profiled start is slower than an unprofiled one. The file holds function names and the paths of Orivon's own files, which include the home folder's name, and goes only where the person who started Orivon asked. [`scripts/startup-profile-summary.mjs`](../../../scripts/startup-profile-summary.mjs) reads one in a terminal, over a window given in the start-up line's milliseconds (`docs/development/setup.md` section Profiling a start).
