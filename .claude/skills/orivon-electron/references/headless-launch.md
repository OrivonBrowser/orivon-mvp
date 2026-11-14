# Launching Electron headless, and leaving nothing behind

## `ELECTRON_RUN_AS_NODE`

The ambient shell sets `ELECTRON_RUN_AS_NODE=1`. It makes the Electron binary run as plain Node: no windows, no
`require('electron')`, no `MessagePortMain`. It does not fail loudly; it fails in ways that look like unrelated bugs,
such as a module-format error that has nothing to do with module formats.

Go through `test/support/launch-electron.mjs` (or `spike/launch.mjs`'s `launchElectron()` for a spike gate), which
strips the variable and asserts `MessageChannelMain` exists before returning. New Electron-launching code does the
same, or a test can produce a confident, completely false result:

```js
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE
const app = await electron.launch({ args: [appPath], env })
const isReal = await app.evaluate(({ app, MessageChannelMain }) =>
  typeof app?.getVersion === 'function' && typeof MessageChannelMain === 'function')
if (!isReal) throw new Error('not real Electron: refuse to trust any result from this run')
```

## A launch that leaves anything behind is not a finished launch

What a *failed* e2e run can leave behind on this machine: orphaned Electron processes reparented to `systemd --user`,
`<defunct>` zombies, a launch with **no `Xvfb` process at all** (so it painted on the real display), and abandoned
`/tmp/orivon-test-*` profile directories (77 of them, 105 MB, in one measured case).

Four rules, part of the test contract rather than cleanup hygiene:

1. **`scripts/run-headless.mjs` on every launch, no exceptions.**
   `env -u ELECTRON_RUN_AS_NODE node scripts/run-headless.mjs ...`. The `-u` is the trap above; the runner puts the
   launch on a virtual display, which bare `xvfb-run` does not guarantee on a Wayland desktop (last section).
2. **Teardown must run on the failure path.** A bounded `app.close()` race works when the test passes and silently
   does not when it throws: put the teardown in a `finally`/`afterAll` that always runs, SIGKILL the process tree
   after the bounded wait, and reap the child so no zombie survives. `app.close()` can hang indefinitely (the e2e
   helpers document it), so the bounded wait and the kill must both run on the failure path.
3. **Check for survivors before reporting the run.** Zero Electron processes, zero zombies, zero stray `Xvfb`.
4. **Delete the `--user-data-dir` temp profile** the run created.

**The trap inside the check itself:** `pgrep -f node_modules/electron/dist/electron` matches *the command doing the
checking*, because that string is in its own argv. It reports processes that do not exist, which reads as a leak and
sends you hunting for nothing. The same happens when the string sits anywhere in a larger pipeline you are running.
Resolve `/proc/<pid>/exe` and compare the real binary path instead, or at least filter with
`ps -eo pid,cmd | grep -F ... | grep -v grep`:

```sh
for p in /proc/[0-9]*; do
  case "$(readlink "$p/exe" 2>/dev/null)" in
    *node_modules/electron/dist/electron*) echo "survivor: $(basename "$p")" ;;
  esac
done
```

## `xvfb-run` is not enough on a Wayland desktop

**The symptom:** a run "headless" by its log (*using a virtual display*) opens a window **on the owner's real
screen, in front of what they are typing**, stealing focus.

**The cause.** `xvfb-run` starts an X server and sets `DISPLAY`. It does nothing about `WAYLAND_DISPLAY`, which a
Wayland session leaves in the environment. Electron's ozone layer auto-detects a backend, finds Wayland available,
prefers it, and connects to the **real compositor**. The virtual display sits unused. Nothing errors, and the
reassuring log line is printed by the wrapper before any of this happens.

**How to tell which backend a running Electron actually chose:**

    ps -eo cmd | grep -F node_modules/electron/dist/electron | grep -oE 'ozone-platform=[a-z0-9]+'

`wayland` means it is on the real desktop. `x11` under `xvfb-run` means it is genuinely virtual.

**The fix, in `scripts/run-headless.mjs`:** remove `WAYLAND_DISPLAY` from the child environment (and downgrade
`XDG_SESSION_TYPE`) whenever the virtual-display path is taken, so X11 is the only backend ozone can discover, the
one `xvfb-run` just pointed at the virtual display.

**Do NOT "fix" this by passing `--ozone-platform=x11`.** `src/main/index.ts` warns that forcing it crashes the GPU
process. Changing what the child can *discover* is safe; changing what the app *asks for* is not.

### Two false positives that waste time

**1. A `dev` session looks exactly like an orphaned test tree.** Many Electron processes with no `Xvfb` running is
what a leaked test tree looks like, and also what `npm run dev` looks like. Killing it destroys the owner's live
work. **The distinguishing signal is the profile path and the parent**, never the process count:

    ps -eo pid,ppid,cmd | grep -F node_modules/electron/dist/electron | grep -oE 'user-data-dir=[^ ]*'

`--user-data-dir=~/.config/orivon` with a live `electron-vite dev` parent is the **owner's own session: leave it
alone.** A `/tmp/orivon-test-*` profile is a test run and is yours to clean.

**2. `pgrep -f` matches your own shell command**, so the post-run survivor check can report a leak that does not
exist. Use the `/proc/<pid>/exe` recipe above before concluding a run left something, or you will "clean up" a run
that already tore down correctly.
