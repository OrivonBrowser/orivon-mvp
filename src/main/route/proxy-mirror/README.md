# `src/main/route/proxy-mirror/`: a copy of the system's proxy settings, with the names the verifier serves left out

**What lives here.** The part of [ADR-0107](../../../../docs/decisions/ADR-0107-the-systems-proxy-settings-are-copied-into-orivons-sessions-with-the-names-the-verifier-serves-left-out-and-polled-for-changes.md)
that reads what the computer's proxy settings say, turns it into a config `session.setProxy` takes, and keeps the copy true.
A session that follows the system takes the copy through the route controller's `systemConfig` and `systemChanged`
([`../route-controller.ts`](../route-controller.ts)); this folder decides what that config is and when it changes.

| File | Job | Durable or tied to Electron |
|---|---|---|
| `settings-source.ts` | Which of the computer's settings carry its proxy (GNOME, KDE, Windows, macOS, the environment), picked as Chromium's `system` mode picks them, and the words for what a read comes to (`SystemSettings`) | Durable: pure over the platform and the environment |
| `read-gnome.ts` | `gsettings list-recursively org.gnome.system.proxy` turned into `SystemSettings`; reads only the keys it needs, so a password in the output reaches nothing | Durable: pure |
| `run-readers.ts` | Runs `gsettings` (`execFile`, no shell, 3 seconds, an error that names neither the output nor the arguments) | Tied to the operating system: it starts a program |
| `mirrored-config.ts` | The config for manual settings: the system's rules and exceptions, then `*.suffix` for every routed suffix | Durable: pure |
| `canaries.ts` | The addresses the copy is checked with: two ordinary sites and up to three the system's exceptions cover | Durable: pure |
| `proxy-mirror.ts` | The poller: reads every 30 seconds, asks Chromium's own answer every 2 seconds, checks a copy before applying it, sets the sessions again until each has taken it, and puts every session back on `{ mode: 'system' }` whenever it cannot read, carry or check (a copy already applied outlasts a failed read or a check with no answer) | Free of Electron, over the calls it is handed; its checks rest on how Chromium's `system` mode answers (tied to Chromium) |
| `mirror-status.ts` | What `orivon://report` and the log say about the mirror: four fixed words | Durable: pure |

**What it depends on.** [`../system-follow.ts`](../system-follow.ts) (the config's type), [`../within.ts`](../within.ts), and
[`../../../protocols/builtin.ts`](../../../protocols/builtin.ts) (which suffixes the verifier serves). `run-readers.ts` uses `node:child_process`.

**What it must never import.** The Electron package: `../route-subsystem.ts` supplies the sessions. Nothing here calls `setProxy` or dials
anything; the sessions it asks are handed in, so a unit test drives all of it against fakes.

**Owner stream.** `broker`.

## Design notes

**The copy is tried on a session of its own, and applied to the others only after it agrees.** `orivon-system-check` is set to the candidate
config and asked for the same addresses as `orivon-system-proxy`, which never leaves `{ mode: 'system' }` and so is Chromium's own answer. A
session that carries traffic is never set to a config that was not checked. A mirror that applied first and checked after would send
ordinary traffic wherever a misread said until the check ended, at every read for as long as the disagreement lasted. A difference is read
again at once, since the system may have moved between the read and the question; a second one leaves every session on
`{ mode: 'system' }`, where the guard in [`../verifier-name-guard.ts`](../verifier-name-guard.ts) decides, and the next read tries again.

**A copy that already passed its check outlasts a read that failed and a check that got no answer.** While one is applied, a `gsettings`
read that failed (`unreadable`), or a check in which a session did not answer within 5 seconds (or the check session was not set), changes
nothing as long as Chromium's two base answers are what they were when the copy passed: putting the sessions on `{ mode: 'system' }`
for one slow call would refuse the names until the next read, and each change of config opens the guard's window of waiting for the
sessions' proxies to be set. A read that succeeds and differs, a check that gets a real different answer (even beside one that got none),
a read that fails after such a difference, and a change of the base answers all take the normal path. An unanswered check is not
recorded as done, so the next read checks the settings again.

**The sessions are set again until each has taken the config.** `apply` reports whether every session took it; when one did not (a
`setProxy` that failed or ran out of time), the next pass calls it again whether or not the settings changed, and a pass that sees nothing
new does only that.

**A pass that ends after `stop()` applies nothing.** The check session is not set either, and the route subsystem registers the stop
before it waits for the first read.

**Settings that are not a manual proxy are not copied.** No proxy (`none`, or `manual` with no server named) stays on `{ mode: 'system' }`:
it is the same answer, and a proxy turned on is followed by Chromium itself until the next pass applies the copy, with the guard refusing a
name meanwhile. A script and automatic detection stay on it too; each is reported by its own word (`script`, `detect`).

**Each GNOME rule is what Chromium's GSettings reader makes of the key, measured.** `use-same-proxy` and the HTTP server's `enabled` switch are
not read at all; a server with an empty host is unset; a `socks` server is SOCKS5 and answers for every scheme with no server of its own;
`ignore-hosts` entries match as Chromium matches a bypass rule written the same way (`*.corp.test` and `.corp.test` match `www.corp.test` and
not `corp.test`; `corp.test` alone matches that host only). `*.eth` does not match `fixture.eth.`, the root-dot spelling, and the resolver
rules (`MAP *.eth`) do not map that spelling to the verifier either, so no rule for it is added: a rule that sent it direct would have
Chromium resolve the name itself and let it leave this computer. It stays on the proxy, where the guard refuses it. An IPv6 address in the
list is passed as the system wrote it, since Chromium's own reader hands each entry to the same bypass-rule parser as it stands.

**An unchanged read does nothing.** The settings and Chromium's two base answers are compared with the last pass; only a difference, or a
state that is not settled (`unreadable`, `disagrees`), runs the check again. The 2-second question is asked in process of the session
that only follows the system: it costs no process and no network for fixed rules.

**The report says which word, never which address.** `mirror-status.ts` holds the source (`gnome`), what the read came to (`manual`,
`none`, `script`, `detect`, `unsupported`, `unreadable`, `unknown`), whether the sessions are mirrored or on the system's own, and why.
`gsettings` prints an `authentication-password` line, so no output is logged and the parser has no field a password could reach.
