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
| `read-kde.ts` | The `[Proxy Settings]` section of every `kioslaverc` read, merged and turned into `SystemSettings` the way Chromium's KDE reader makes the same files of them; reads only the keys it needs, so a credential in a server entry reaches nothing | Durable: pure |
| `read-kde-files.ts` | Finds the `kioslaverc` files where Chromium looks for them (by `KDEHOME`, `HOME`, `XDG_CONFIG_DIRS` and the KDE generation) and opens them: a file read of at most a megabyte, three seconds | Tied to the operating system: it reads files |
| `read-windows.ts` | `reg query` of the per-user Internet Settings key, its connection blob and the machine policy turned into `SystemSettings`, by the rule Chromium's reader follows; reads only the values it needs | Durable: pure |
| `run-readers.ts` | Runs `gsettings`, `reg.exe` and `/usr/sbin/scutil` (`execFile`, no shell, 3 seconds, an error that names neither the output nor the arguments) | Tied to the operating system: it starts a program |
| `mirrored-config.ts` | The config for manual settings (the system's rules and exceptions, then `*.suffix` for every routed suffix) and for a script (its wrapped text as a `data:` address) | Durable: pure |
| `pac-wrapper.ts` | The system's proxy script made into a script of Orivon's own that answers `DIRECT` for every routed name before the system's text runs, and runs that text where it cannot reach what decides it | Durable: pure text, which Chromium's PAC context runs |
| `pac-fetch.ts` | Fetches the text of the script the system names, direct, with no cookies or credentials, at most a megabyte and 30 seconds, decoded as Chromium decodes it | Tied to Electron: it makes a session of its own and asks it |
| `canaries.ts` | The addresses the copy is checked with: two ordinary sites and up to three the system's exceptions cover, never one that names a host the verifier serves, since asking `orivon-system-proxy` about it would run the system's script with the name | Durable: pure |
| `proxy-mirror.ts` | The poller: reads every 30 seconds, asks Chromium's own answer every 2 seconds, fetches the script the settings name when it is due, checks a copy before applying it, sets the sessions again until each has taken it, and puts every session back on `{ mode: 'system' }` whenever it cannot read, fetch, carry or check (a copy already applied outlasts a failed read or a check with no answer) | Free of Electron, over the calls it is handed; its checks rest on how Chromium's `system` mode answers (tied to Chromium) |
| `mirror-status.ts` | What `orivon://report` and the log say about the mirror: four fixed words | Durable: pure |

**What it depends on.** [`../system-follow.ts`](../system-follow.ts) (the config's type), [`../within.ts`](../within.ts), and
[`../../../protocols/builtin.ts`](../../../protocols/builtin.ts) (which suffixes the verifier serves). `run-readers.ts` uses `node:child_process` and `node:path`, and `read-kde-files.ts` `node:fs/promises`.

**What it must never import.** An Electron value (a type is fine): `../route-subsystem.ts` supplies the sessions. Nothing here calls `setProxy` on a
session that carries traffic, and the one thing that makes a request is `pac-fetch.ts`, to the address of the script the system names; the sessions
and the fetch are handed in, so a unit test drives all of it against fakes.

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

**Settings that are neither a manual proxy nor a script are not copied.** No proxy (`none`, or `manual` with no server named) stays on `{ mode: 'system' }`:
it is the same answer, and a proxy turned on is followed by Chromium itself until the next pass applies the copy, with the guard refusing a
name meanwhile. Automatic detection stays on it too, reported by its own word (`detect`). A script that could not be fetched (`unfetched`:
the fetch failed, or the address is not `http:` or `https:`) and one whose copy does not answer as Chromium's session does (`disagrees`) stay on it as well.

**A system script is copied by wrapping its text, and the wrapper is what keeps a routed name off the script's proxy.** `pac-wrapper.ts` builds
a script of Orivon's own and hands it to the sessions as a `data:` address. The system's text sits in it as one string of printable ASCII (each
other UTF-16 unit is a `\uXXXX` escape, so no charset or line terminator changes what it says), and runs once, through `Function`, inside a
closure of the wrapper's: the text cannot name the closure's variables, so it cannot reach the routed check or its table. Chromium reads the
global `FindProxyForURL`; the wrapper defines it as an accessor that cannot be redefined or deleted, and a text that assigns the name (bare, as
`this.` or `globalThis.`, in strict mode, through `eval` or `new Function`, inside `with`) hands the setter its function, which is the one
wrapped. The routed check compares characters by index against both spellings of every routed suffix and calls nothing on the host or on a
prototype, so a text that replaces `String.prototype` or `Array.prototype` methods changes nothing; it drops every trailing dot of the host
(Chromium hands a script the host with the root dots kept, in lower case) and treats a host that is not a string as routed. A text that does not
compile, throws while it loads, defines no function or throws when asked answers `DIRECT`, as Chromium's own session does for a script that
fails, so a broken text cannot send anything to a proxy either; a load that failed is final, so a function assigned later (from a promise the
text started) is not taken. A text does not see the wrapper: the stack, `caller`, `arguments.callee` and `prepareStackTrace` frames reach only
strict functions, which hand out neither the function nor its `this`. Measured in Chromium's PAC context: it honours a non-configurable accessor
for `FindProxyForURL`, runs `Function`-compiled code with the helpers (`dnsResolve`, `isInNet`, `shExpMatch` and the rest) as globals, and
makes a new context for each `setProxy` of a `data:` address. The size of the address is no limit: addresses up to 16,000,054 characters
(12 MB of script, answered by the script) applied, and the longest one `pac-fetch.ts` can lead to is 8,390,482 characters (a megabyte of
control characters, each escaped as six). `pacDataUrl` refuses anything that is not ASCII, because base64 of Latin-1 would change what a
character says. The text runs as the body of a function, not as a top-level script, so its `var` and function declarations are local
to it and not properties of the global: a script that reads one back through `this` or `globalThis` sees something else than it does
in Chromium's own context. Only the check catches such a difference, and only on its canary hosts (`example.com` over http and https).

**The script is fetched by a session of Orivon's own, direct, and only from the address the system names.** `orivon-pac-fetch` lives in memory, is
set to `{ mode: 'direct' }` before its first request and is marked as one that sets a proxy of its own, so the fetch goes through no proxy
(the script's own, a tunnel or the mirrored one). It sends no cookies or credentials, caches nothing, takes only `http:` and `https:` (also after
a redirect) and an answer with status 200, and stops at a megabyte (one byte more fails, as in Chromium) and at 30 seconds. The text is decoded by the
charset the answer names, else by a byte-order mark, else as Latin-1 (what Chromium does); a failure is one word (`scheme`, `credentials`,
`status`, `size`, `time`, `network`, `charset`) and carries neither the address nor the text.

**The script is fetched again when the copy could be out of date, and Chromium's own session is told to read it again when the text changed.** A fetch
is due for a new address, once the text is half an hour old, when Chromium's answers changed and the last attempt is 20 seconds old, and once more
in the same pass when the copy and Chromium's answers differ and no fetch has been made in that pass. Chromium's own session notices an edit of a
script at the same address late or not at all (measured: nothing within 150 seconds), but `forceReloadProxyConfig` on it makes it fetch the script
again (measured), so a changed text, and a difference that stays, have the mirror ask for that before the check, once per pass. A fetch that fails
keeps the last text for the same address; with none, the sessions stay on the system's own. The text is forgotten when the settings stop naming a script.

**A script that answers differently at every question stays with the system, and costs one pass per read.** A copy that answers by the clock or
at random seldom agrees with Chromium's own answer (`disagrees`), though a counter in step with the two questions of a pass can agree, and the
copy is then as harmless as any other: it sends no routed name to a proxy. The 2-second question sees such a change every time. A change in Chromium's answers with
the settings the same starts a pass only once a minute, so the reads of the settings (a process each) stay at the 30-second pace, with one fetch
and one reload of Chromium's session at most per pass.

**Each GNOME rule is what Chromium's GSettings reader makes of the key, measured.** `use-same-proxy` and the HTTP server's `enabled` switch are
not read at all; a server with an empty host is unset; a `socks` server is SOCKS5 and answers for every scheme with no server of its own;
`ignore-hosts` entries match as Chromium matches a bypass rule written the same way (`*.corp.test` and `.corp.test` match `www.corp.test` and
not `corp.test`; `corp.test` alone matches that host only). `*.eth` does not match `fixture.eth.`, the root-dot spelling, so the exceptions carry `*.eth.` too (`routedBypassRules` in
`../verifier-name-guard.ts`, the one list every bypass of these names is made from): the resolver rules refuse that spelling
(`MAP *.eth. ~NOTFOUND`), so it goes direct and fails as not found, and neither a resolver nor the proxy is asked for it. An IPv6 address in the
list is passed as the system wrote it, since Chromium's own reader hands each entry to the same bypass-rule parser as it stands.

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

**Each KDE rule is what Chromium's `kioslaverc` reader makes of the key, measured.** Chromium reads `$HOME/.config/kioslaverc` for KDE 5 and 6,
the `XDG_CONFIG_DIRS` below it, and `$KDEHOME/share/config` alone when `KDEHOME` is set; it never looks at `XDG_CONFIG_HOME`, though KDE
writes there, so the reader follows Chromium and not KDE. Without `KDE_SESSION_VERSION` 5 or 6 Chromium takes the desktop for KDE 4 and
reads `~/.kde` or `~/.kde4`, whichever changed last. The files are merged key by key, the later one winning, and an empty server in a later
file does not clear an earlier one. A line of 511 bytes or more, and a last line with no newline, are skipped. A server is `host port` or a
URL: the scheme and the credentials are dropped, and a `socks` server is SOCKS5 unless it says `socks4`. `NoProxyFor` entries are split at
commas and spaces, and Chromium turns every hostname among them into a suffix match by putting a `*` in front (`corp.test` is
`*corp.test`, which also matches `xcorp.test`); `setProxy` does not do that to the exceptions it is given, so the reader does, and leaves
a rule for an address, a block of addresses and `<local>` as it is. No `kioslaverc`, or no type in it, is no proxy (`none`): Chromium then reads the
environment, which Orivon already keeps the names out of. Reversed exceptions, a type 4 (the servers are names of environment variables)
and a server or exception that could not be written into a rule are `unsupported`.

**The report says which word, never which address.** `mirror-status.ts` holds the source (`gnome`, `kde`, `windows`, `macos`), what the read came to (`manual`,
`none`, `script`, `detect`, `unsupported`, `unreadable`, `unknown`), whether the sessions are mirrored or on the system's own, and why. The address of a script and its text reach neither the log nor the report.
`gsettings` prints an `authentication-password` line, and a KDE server entry can hold `user:password@`, so no output is logged and neither parser has a field a password could reach.
