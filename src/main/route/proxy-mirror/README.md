# `src/main/route/proxy-mirror/`: a copy of the system's proxy settings, with the names the verifier serves left out

**What lives here.** The part of [ADR-0107](../../../../docs/decisions/ADR-0107-the-systems-proxy-settings-are-copied-into-orivons-sessions-with-the-names-the-verifier-serves-left-out-and-polled-for-changes.md)
that reads what the computer's proxy settings say, turns it into a config `session.setProxy` takes, and keeps the copy true.
A session that follows the system takes the copy through the route controller's `systemConfig` and `systemChanged`
([`../route-controller.ts`](../route-controller.ts)); this folder decides what that config is and when it changes.

| File | Job | Durable or tied to Electron |
|---|---|---|
| `settings-source.ts` | Which of the computer's settings carry its proxy (GNOME, KDE, Windows, macOS, the environment), picked as Chromium's `system` mode picks them, and the words for what a read comes to (`SystemSettings`) | Durable: pure over the platform and the environment |
| `read-gnome.ts` | `gsettings list-recursively org.gnome.system.proxy` turned into `SystemSettings`; reads only the keys it needs, so a password in the output reaches nothing | Durable: pure |
| `read-windows.ts` | `reg query` of the per-user Internet Settings key, its connection blob and the machine policy turned into `SystemSettings`, by the rule Chromium's reader follows; reads only the values it needs | Durable: pure |
| `run-readers.ts` | Runs `gsettings` and `reg.exe` (`execFile`, no shell, 3 seconds, an error that names neither the output nor the arguments), and says which reader a computer has (`readerFor`) | Tied to the operating system: it starts a program |
| `mirrored-config.ts` | The config for manual settings: the system's rules and exceptions, then `*.suffix` and `*.suffix.` for every routed suffix | Durable: pure |
| `canaries.ts` | The addresses the copy is checked with: two ordinary sites and up to three the system's exceptions cover | Durable: pure |
| `proxy-mirror.ts` | The poller: reads every 30 seconds, asks Chromium's own answer every 2 seconds, checks a copy before applying it, and puts every session back on `{ mode: 'system' }` whenever it cannot read, carry or check | Free of Electron, over the calls it is handed; its checks rest on how Chromium's `system` mode answers (tied to Chromium) |
| `mirror-status.ts` | What `orivon://report` and the log say about the mirror: four fixed words | Durable: pure |

**What it depends on.** [`../system-follow.ts`](../system-follow.ts) (the config's type), [`../within.ts`](../within.ts), and
[`../../../protocols/builtin.ts`](../../../protocols/builtin.ts) (which suffixes the verifier serves). `run-readers.ts` uses `node:child_process`
and `node:path`.

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

**Windows keeps the proxy in two forms, and Chromium reads them by a rule that is neither one alone, measured.** The values under
`HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` (`ProxyEnable`, `ProxyServer`, `ProxyOverride`, `AutoConfigURL`,
`AutoDetect`) are what most tools write; the `DefaultConnectionSettings` blob under its `Connections` key (flags 1 direct, 2 proxy, 4 script,
8 detect, then the three strings) is what Internet Options writes beside them. The values are the manual proxy's when `ProxyEnable` is on (with
no `ProxyServer` that is no proxy), or off beside a `ProxyServer` (no proxy, whatever the blob holds); without a `ProxyEnable` value, or with
one that is off and no `ProxyServer`, the blob is, and a `ProxyServer` value alone is ignored. A script comes from the `AutoConfigURL` value or
from a blob with flag 4 and an address, and wins over a
manual proxy in both forms; a blob address under flag 1 is not used. A running session follows a change of either form at its next question.
Detection is reported from the `AutoDetect` value or the blob's flag 8, which of them Windows honours was not measured (the runners have no
detection server); beside a manual proxy it changes nothing here, since the manual part is copied and the canary check judges it. `ProxyServer`
and `ProxyOverride` pass as written, because `setProxy` reads them with the parser that reads them in `system` mode, and the override list is
split at the separators Chromium's Windows reader splits it at (`;`, `,` and white space), so no entry holds one. The machine policy that
makes the settings per machine (`ProxySettingsPerUser` 0) is `unsupported`; a blob cut short or of a layout this reader does not know is
too, and a blob of no bytes is no blob. `reg.exe` exits with 1 for every error it reports, a key or value that is not there among them, so
a query that exits with 1 reads as nothing set (for the Internet Settings key itself, which always exists, that is `unreadable`); a query that
takes too long or cannot start is `unreadable` whichever it was, and the canary check judges what the rest comes to. A read starts three `reg.exe`
processes at once (about 26 ms of wall time and 14 ms of CPU each on a GitHub Windows runner), and the 30-second reads with the 2-second question
cost 0.6% of one core in all of Orivon's processes together over twenty minutes.

**An unchanged read does nothing.** The settings and Chromium's two base answers are compared with the last pass; only a difference, or a
state that is not settled (`unreadable`, `disagrees`), runs the check again. The 2-second question is asked in process of the session
that only follows the system: it costs no process and no network for fixed rules.

**The report says which word, never which address.** `mirror-status.ts` holds the source (`gnome`, `windows`), what the read came to (`manual`,
`none`, `script`, `detect`, `unsupported`, `unreadable`, `unknown`), whether the sessions are mirrored or on the system's own, and why.
`gsettings` prints an `authentication-password` line, so no output is logged and the parser has no field a password could reach.
