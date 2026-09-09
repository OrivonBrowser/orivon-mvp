# Native apps in a tab, via Linux containers

**Status: parked, post-MVP. Not a commitment and not scheduled.** This document exists so the
analysis is not re-derived from scratch, and so the assumptions behind the numbers are visible
when someone checks them. Explored with the owner on 2026-09-08 and 2026-09-09.

## The idea

Run an existing native desktop application -- JVM, Qt, GTK -- unmodified, inside a Linux
container, with a virtual screen inside that container, and stream its windows into an ordinary
Orivon tab. The user sees the app in a tab. The app sees a normal Linux desktop.

`app-compatibility.md` places these in **tier 3** ("must rewrite the frontend, bundle a
supervised helper process") and cuts them from the MVP for that reason -- Bisq is its worked
example. This approach is a fourth path that document does not consider: **tier 3 stops costing
a rewrite and starts costing an image build.**

Two consequences worth stating, because neither is obvious:

- It also reaches the **wallet cluster blocked on `hid`/USB** (Ledger Live, Trezor Suite). Those
  are tier 2 but excluded from v0 because a renderer cannot reach USB. A native app in a
  container talks to the device on the host side, so the browser never needs the capability.
- It does **not** help tier 1 or tier 2, which are already cheap. The win is one tier wide, not
  general. "Compatible with most apps" overstates it.

## Why it is parked

Estimated at 5-8 weeks standalone, which the owner judged too expensive. That number was then
found to be wrong in a way that matters: **3-5 of those weeks were the permission machinery and
the mediated transport, both of which the capability broker already builds.** See the estimate
below. The owner has not restated a go/no-go decision on the corrected number; the status here
is "parked with the cost basis corrected", not "rejected".

## The hard constraint that came out of this

**Owner's decision, 2026-09-09: rendering inside a tab is a property of the product, not a
feature of any build step.** A cheaper variant was proposed and rejected -- Orivon launches the
native app as its own operating-system window and acts only as launcher and permission manager.
That captures most of the compatibility win for a fraction of the work, which is exactly why it
will keep being proposed. It is rejected because an app that opens its own window outside the
browser makes Orivon an app launcher rather than a browser, and "impossible-in-Chrome apps, in a
tab" is the thing being sold.

Do not offer that shortcut again as a way to save time.

## The shape assumed here

Three pieces, and only the first is code written in this repository.

| Where | What |
|---|---|
| Orivon main process | A supervisor that starts and stops the container, and bridges it to the tab |
| Inside the container | Virtual screen, minimal window manager, the app, and **xpra** |
| The tab | xpra's web client -- an ordinary web page |

### Podman, not Docker

*AI recommendation.* Daemonless, runs without administrator rights, and Apache-2.0 with no
licence threshold for companies above a certain size. Docker Desktop has one.

### xpra, not neko or Kasm

*AI recommendation, and two independent reasons point the same way.*

1. **It sends windows, not a desktop.** neko and Kasm put a whole Linux desktop in the tab --
   wallpaper, taskbar, window frames. xpra has a seamless mode that forwards the application's
   own windows. For "the app is in the tab", the second is the product; the first looks like a
   computer inside a computer.
2. **It speaks WebSocket, which can ride Orivon's own channel.** neko uses WebRTC, which is
   awkward to tunnel. This matters because of the security constraint below.

### The transport, and why it is not a localhost port

Every off-the-shelf streaming stack serves on a local port. `security-model.md` **T15** already
rules that out for a weaker case -- torrent media is served renderer-locally precisely so no
other local process can reach it -- and a container holding a wallet is a stronger case, not a
weaker one. An unauthenticated local port carrying a live wallet session that accepts input is
the whole threat in one sentence.

The intended answer is to reach the container through **`orivon.net.connect`**, mediated by the
broker, so only the app that was granted it can connect. This is a design intent, not a built
thing: see the assumptions below.

### What it reopens

- **`subprocess`**, removed from v0 in `capability-api.md` on the grounds that no tier-3 app is
  in the MVP and it "costs the largest attack surface in the design". This reopens it, but in a
  much narrower shape: not "run any program", but "start the container image this manifest
  declares". The manifest states the image, whether it gets network, and which paths are
  mounted; the existing grant, prompt and revocation machinery then applies unchanged.
- **T15**, above, which is respectable but must be respected deliberately.

Neither should be reopened quietly. Both were closed with written reasons.

## The estimate

Linux only. The right-hand column assumes the broker and shim have landed as planned.

| | Standalone | After the broker |
|---|---|---|
| Image built by hand, app and xpra inside, opened in an ordinary browser | 2-4 days | unchanged |
| Container lifecycle: start, stop, mount, clean up | folded into the rows below | **~1 week** -- the only genuinely new capability |
| Bridge between xpra's WebSocket client and `orivon.net` | | **days** |
| Attach to Orivon with no exposed port | 2-3 weeks | absorbed by the two rows above |
| Manifest, prompt, grant, revocation | 1-2 weeks | **days** -- the machinery exists |
| The user does not have Podman: what they see | not estimated | **still not estimated** |
| **Total** | **5-8 weeks** | **2-4 weeks** |

The broker does not make the streaming cheaper. It makes the *permission* half nearly free, and
that half was most of the estimate.

## Windows and macOS

**The code is one path on all three systems**, because the capture stack lives inside the
container and is therefore always Linux. This is the reason this approach was preferred over
capturing the app on the host, which needs separate input-injection code per operating system
and was estimated in months for that reason alone.

The cost moves from development to the user's first run:

| | What the user needs | Weight |
|---|---|---|
| Linux | Podman | One line |
| Windows | WSL2 enabled (reboot, sometimes a BIOS setting), then Podman | Reboot plus 1-2 GB |
| macOS | Podman plus a Linux virtual-machine image | 1-2 GB, and the VM stays resident |

On Windows and macOS this is a Linux **virtual machine** containing the container, not a
container: a couple of GB of resident memory and a slower first start.

Two costs not visible in that table:

- **Apple Silicon needs its own image.** Either build two images per app or accept emulated
  performance. This is per-app work, not one-time.
- **No GPU inside the VM** by default. Irrelevant for a forms interface like Bisq; disqualifying
  for anything animated.

## Startup time

The container adds a fixed few seconds. Everything else is the application's own startup.

| Situation | Time |
|---|---|
| First run ever -- downloads the image (700 MB - 1.5 GB) | 3-10 min, almost entirely download |
| App stopped, image already present | ~5 s of system, plus the app's own start |
| App already running in the background, tab reopened | **under a second** |
| macOS or Windows with the VM stopped | plus 10-30 s to start it |

**xpra's session survives disconnection**, which is what it was built for. The app stays running
inside the container and reopening the tab reattaches to the session already there. The long
wait is paid once per session, not once per tab open.

The price is memory: roughly 500 MB - 1 GB per warm app, plus the VM on macOS and Windows. That
implies a ceiling on how many stay warm -- and following the pattern set by the socket allowance
(`open-questions.md` A80), that ceiling should be something the user sees and consents to rather
than a number chosen silently.

Bisq is the worst case in its class: JVM, JavaFX, and a Tor bootstrap, which is 30-90 seconds
even when launched normally on the host. A lighter app with no network bootstrap is 2-5 seconds.

**An ordinary Orivon app opens in a fifth of a second.** A container app does not. This is
starting an application, not navigating -- acceptable, but only if the interface says so rather
than looking like a tab that has hung. That work sits in the row that is still not estimated.

## The unestimated row

"The user does not have Podman: what they see" was never estimated, and it is the row that
decides whether anyone uses this. On Linux it is an annoyance, on Windows a reboot, on macOS a
1.5 GB download -- and Windows and macOS are where the users are.

## Assumptions, and what is not verified

Recorded per Rule 2. **None of the following was tested in this repository.** They are the load-
bearing beliefs behind every number above.

| Assumption | Confidence |
|---|---|
| xpra's seamless window mode looks like an app in a tab, not a desktop | Documented behaviour, never seen here |
| xpra's WebSocket transport can be tunnelled over `orivon.net.connect` | Plausible, untested. If false, the T15-clean design needs rethinking |
| The WebSocket bridge is days of work, not weeks | Estimate |
| Bisq runs in a container with Tor working | Very likely, untested |
| Image sizes of 700 MB - 1.5 GB | Estimate |
| Bisq's 30-90 s start | General knowledge, not measured here |
| Podman on Windows uses WSL2, and on macOS a Linux VM | High confidence |

The cheapest way to falsify most of this is the first row of the estimate table: one image built
by hand, opened in an ordinary browser, no Orivon involved. Two to four days, and it either
shows dialogs and resizing working or it does not.

## The alternative not taken, still worth two hours

**CheerpJ**, which runs compiled Java inside a web page. Bisq is Java, so it would run in a tab
and on every platform *by construction* -- no container, no virtual machine, no prerequisite --
and the sockets it needs would come from `orivon.net`, meaning the MVP being built now would be
the engine.

**Whether it supports JavaFX is genuinely unknown to the author of this document**, and that
single question decides whether the idea is excellent or dead. Checking is hours, not weeks:
either a Bisq window appears or it does not. Worth doing before committing to the container
path, because if it works it is better on every axis.

Related: WebVM / CheerpX, which run a full x86 Linux in a page. Same family, much heavier, and
performance for a JVM application is the open question.
