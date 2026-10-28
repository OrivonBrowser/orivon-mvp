# `src/main/self-update/`: look for a newer release, tell the person in the window, never install

**What lives here.** The browser looks for a newer release of itself and tells the person in the window they are
using. `update-check.ts` is the decision table (is a look due, is a version newer) and `checkForUpdate`, which keeps
the reason a look failed. `update-notice.ts` is the rules: the release found is kept until the running version
catches up, the person is asked once per version, and a version counts as told only once its question was on screen and
answered or dismissed.
`update-ask.ts` is the question's words and buttons. `update-window.ts` picks the window to ask in and acts on the
answer; `update-check-runner.ts` is the real I/O (the state file, the GitHub fetch, `createBrowserUpdate`, which
`shell/shell-services.ts` builds once per process); `install-update-notice.ts` is the shell installer that schedules
the look and retries while a release waits for a window. `updates-domain.ts` is what Settings may ask: to look now,
what is on offer, and to open the release page. `update-schedule.ts` runs the look at start, hourly, and when the
setting is switched on. `newest-release.ts` picks the newest release from the list GitHub answers, pre-releases
included (every release here is one), skipping drafts and tags that are not versions. `github-release-version.ts`
parses release tags, and must not merge with the broker's version comparator (its header says why). `release-url.ts`
builds the release page address from fixed constants and a tag that looks like a version, and holds the address of the
newest-release name. `update-test-seam.ts` is the test-build seam.

**Tied to Electron.** `update-check-runner.ts` (imports `net` dynamically), `update-window.ts` (draws the question through
`../shell/question/` and acts on the windows) and `install-update-notice.ts` (a shell installer on the app and its
services). The rest, `update-test-seam.ts` included, imports nothing from Electron.

**What it depends on.** `electron` (`update-check-runner.ts` alone, directly), `node:fs/promises`, `node:path`,
`../shell/question/` (`askQuestion` and the question spec), `../shell/window-registry.ts`,
`../shell/shell-installers.ts` (the installer type `install-update-notice.ts` fills), `../pages/internal-ipc.ts` (the
domain type `updates-domain.ts` fills), `../os/install-default-browser-ask.ts` (`askPlace`, `RETRY_MS`),
`../os/windows-store.ts`, `../route/own-requests.ts` and `../../broker/adapters/atomic-write.ts`. The shell depends on
this directory in turn (`shell-services.ts` builds the notice, `shell-installers.ts` runs the installer), as `os/` and
the shell do on each other.

**What it must never import.** [`../consent/`](../consent/) or [`../install/`](../install/): a browser update and an
app grant are different questions, asked in different dialogs, under different rules.

**Owner stream.** `shell`. Maintenance only. The person tells nothing and nothing looks once they turned `updates.check`
off in Settings (it is on by default; `ORIVON_UPDATE_CHECK=off` forces it off for a run, as every test launch does).
The look reaches GitHub at most once a day, by the stored time of the last look that reached it. A private session
looks at nothing, and neither does a Microsoft Store install (`isStoreInstall`, `../os/windows-store.ts`): the Store
delivers its updates, so Settings says that instead of offering the switch.

**The notice.** A newer release is asked about once per version, in the window in use, with the question panel under
the address bar: "Download from GitHub" opens the release page in a new Orivon tab, "Download from latest.orivonstack.eth"
opens the start page of that name (it downloads the package for the visitor's system; `release-url.ts` holds the address
as a constant, so no release list can name another page) in a new Orivon tab, and "Not now", Escape or a closed tab
dismisses it. Both download buttons are guarded, so a click or key meant for the page under the panel opens neither
page; the way out is not. It is never an operating-system notification or message box (`npm run check:native-dialogs` refuses
both). With no window in use (minimised, hidden, behind the welcome screen or restore bar, another question open, full
screen, or a kiosk) it waits and asks when one is, retrying every few seconds. There is no install button: nothing
here downloads or installs a release. The look does not wait for the answer, so an hourly look still runs while a
question stays open in a tab the person left.

**State.** `update-check-state.json` in the profile holds `lastCheckedAt`, `lastFoundVersion` (the newest release the
last look found, while it is newer than the running version) and `lastNotifiedVersion`. A release found and not yet
told is asked about at the next start, with no call to the network inside the same day. Each profile is its own
process with its own file, so it is asked once in each profile. A look, "Check now" and an answered question can all
write it at once, so `update-notice.ts` runs the writes one after another, each carrying the state as it is then.

**What a report says.** Every step logs a line starting `[self-update]` to the console log that `orivon://report`
carries: a look that reached GitHub (newest tag, running version), one that did not (and why), a release found, a wait
for a window (once per reason), the question asked, and the answer.

**Tests.** `ORIVON_TEST_UPDATE_RELEASE=<tag>` stands a release in for GitHub's answer and
`__orivonDevUpdateCheckNow()` runs one scheduled look, in a test build only (`update-test-seam.ts`;
`scripts/check-dev-grant-absent.mjs` keeps both out of an ordinary build).

## Design notes

**A version counts as told only once its question was on screen and answered.** The state file records
`lastNotifiedVersion` after the person closed a question the panel had drawn, never before it is shown, so a release
that could not be shown (no window in use, a failed panel, a question cancelled before the toolbar was ready) is asked
about again instead of lost. `askQuestion` answers such a cancel exactly as it answers an Escape, so
`update-window.ts` learns whether the panel was up from `AskOptions.onShown`, which fires when the panel's page reports the
question drawn: the overlay page loads cold, so a question closed after the show and before the draw was never on screen
and is not counted. A question that closes unseen is asked again twice more, then waits for the next look. The told version never moves back: if "Check now" in Settings showed a newer
release while a question about an older one was open, answering the old one leaves the newer one told. "Check now" also
counts the release it shows as told: the person has just read it. *Provisional*: whether Settings alone should leave the
question to appear is the owner's call.

**The question is asked only in a place.** `update-notice.ts` receives a `place` that is either a window in use or the
reason there is none, and calls `ask` only with a window. `askQuestion` falls back to an operating-system box when it is
given no window, which this notice must never reach. A `place` that throws (a tab's contents torn down under its window)
counts as a wait with that reason, so `tryAsk` never rejects: the retry timer runs it with nothing above it, and an
unhandled rejection ends the browser.

**Full screen waits.** `update-window.ts` additionally refuses a full-screen window and a page holding the screen, so a
video or a presentation is not interrupted. The rule is here and not in `askPlace`, which the default-browser ask shares.

**Several windows.** Only the window in use is asked, once per profile process; the other windows show nothing.
