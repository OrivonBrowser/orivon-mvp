# `src/main/route/proxy-mirror/`: a copy of the system's proxy settings, with the names the verifier serves left out

**What lives here.** The part of [ADR-0107](../../../../docs/decisions/ADR-0107-the-systems-proxy-settings-are-copied-into-orivons-sessions-with-the-names-the-verifier-serves-left-out-and-polled-for-changes.md)
that reads what the computer's proxy settings say, turns it into a config `session.setProxy` takes, and keeps the copy true.
A session that follows the system takes the copy through the route controller's `systemConfig` and `systemChanged`
([`../route-controller.ts`](../route-controller.ts)); this folder decides what that config is and when it changes.

| File | Job | Durable or tied to Electron |
|---|---|---|
| `settings-source.ts` | Which of the computer's settings carry its proxy (GNOME, KDE, Windows, macOS, the environment), picked as Chromium's `system` mode picks them, and the words for what a read comes to (`SystemSettings`) | Durable: pure over the platform and the environment |
| `read-gnome.ts` | `gsettings list-recursively org.gnome.system.proxy` turned into `SystemSettings`; reads only the keys it needs, so a password in the output reaches nothing | Durable: pure |
| `read-macos.ts` | `scutil --proxy` turned into `SystemSettings`; reads only the keys it needs and only the top level of the dictionary | Durable: pure |
| `run-readers.ts` | Runs `gsettings` or `/usr/sbin/scutil` (`execFile`, no shell, 3 seconds, an error that names neither the output nor the arguments), and `readerFor` names the read for a source | Tied to the operating system: it starts a program |
| `mirrored-config.ts` | The config for manual settings: the system's rules and exceptions, then `*.suffix` and `*.suffix.` for every routed suffix | Durable: pure |
| `canaries.ts` | The addresses the copy is checked with: two ordinary sites and up to three the system's exceptions cover | Durable: pure |
| `proxy-mirror.ts` | The poller: reads every 30 seconds, asks Chromium's own answer every 2 seconds, checks a copy before applying it, and puts every session back on `{ mode: 'system' }` whenever it cannot read, carry or check | Free of Electron, over the calls it is handed; its checks rest on how Chromium's `system` mode answers (tied to Chromium) |
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

**Settings that are not a manual proxy are not copied.** No proxy (`none`, or `manual` with no server named) stays on `{ mode: 'system' }`:
it is the same answer, and a proxy turned on is followed by Chromium itself until the next pass applies the copy, with the guard refusing a
name meanwhile. A script and automatic detection stay on it too; each is reported by its own word (`script`, `detect`).

**Each GNOME rule is what Chromium's GSettings reader makes of the key, measured.** `use-same-proxy` and the HTTP server's `enabled` switch are
not read at all; a server with an empty host is unset; a `socks` server is SOCKS5 and answers for every scheme with no server of its own;
`ignore-hosts` entries match as Chromium matches a bypass rule written the same way (`*.corp.test` and `.corp.test` match `www.corp.test` and
not `corp.test`; `corp.test` alone matches that host only). `*.eth` does not match `fixture.eth.`, the root-dot spelling, so each routed
suffix is added in both spellings. A bare IPv6 address in the list is bracketed.

**Each macOS rule is what Chromium's `SCDynamicStoreCopyProxies` reader makes of the dictionary `scutil --proxy` prints, read from its source and measured on a macOS runner.** Only the top
level counts, never `__SCOPED__`, the copy each network interface keeps below it. A server counts when its `Enable` switch is non-zero and
it names a host; a server that is off has no host or port in the output, and an FTP proxy has no line at all and no effect on `http:` or
`https:`. The HTTPS server is an HTTP proxy for `https:` addresses, a port that is not printed is the scheme's default, and the SOCKS
server is SOCKS5 (`SOCKS5 127.0.0.1:1080`, for every scheme with no server of its own, `ws:` and `wss:` included), so its rule is
`socks=socks5://`. A script that is on beats a manual proxy beside it, since Chromium asks the script first, so it is `script`; but
macOS also turns its script on, at `http://wpad/wpad.dat`, when automatic discovery is ticked, and that is `detect`, never a script of the
person's. Discovery beside a manual proxy copies the manual part, which Chromium answers with when no discovery server is found, and the
check judges it. The exceptions are Chromium bypass rules, and the copy goes through the same parser as the system's own list: a list of
fourteen kinds of entry came out the same in both, one that holds `;` or `,` included, which both cut in the same place, so each entry is
passed as it stands. `169.254/16` changes nothing (link-local addresses bypass a proxy anyway), and `*.local` matches `printer.local`, not
`local`. `<local>` comes first exactly when "Exclude simple hostnames" is on: `http://intranet/` is the proxy's without it and direct with it.
A change made in the Network settings shows in `scutil --proxy` within a tenth of a second and in Chromium's answer a few milliseconds
later, so the delay a person sees is the mirror's own two-second question.

**An unchanged read does nothing.** The settings and Chromium's two base answers are compared with the last pass; only a difference, or a
state that is not settled (`unreadable`, `disagrees`), runs the check again. The 2-second question is asked in process of the session
that only follows the system: it costs no process and no network for fixed rules.

**The report says which word, never which address.** `mirror-status.ts` holds the source (`gnome`), what the read came to (`manual`,
`none`, `script`, `detect`, `unsupported`, `unreadable`, `unknown`), whether the sessions are mirrored or on the system's own, and why.
`gsettings` prints an `authentication-password` line, so no output is logged and the parser has no field a password could reach.
