# ADR-0107: The system's proxy settings are copied into Orivon's sessions with the names the verifier serves left out, and polled for changes

- **Status:** accepted. Carries out `d-0772`. Built in steps (see Consequences): the first changes no behaviour.
- **Date:** 2026-11-08
- **Type:** architecture
- **Decided by:** owner

## Decision

Orivon reads the proxy settings of the computer itself (the Windows registry, `scutil --proxy` on macOS, GNOME's GSettings,
KDE's `kioslaverc`, and the environment's `auto_proxy`), in the same order and with the same desktop detection as
Chromium's `system` mode, and applies the result with `session.setProxy` to every session that would otherwise follow the
system. A manual proxy becomes `fixed_servers` with the system's own rules and exceptions plus every routed suffix
(`BUILTIN_ADDRESSES.routedSuffixes()`) as `*.suffix`, the spelling the resolver rules map to the verifier. A proxy script
the system names by URL is fetched by Orivon, direct, and embedded in a `data:` PAC of Orivon's own that answers `DIRECT` for the routed suffixes before the system's script runs. The applied
config is accepted only while Chromium's own answer, asked of a session that stays on `{ mode: 'system' }`, agrees with it
for a set of ordinary canary URLs; when it does not, and for whatever cannot be copied (automatic detection on its own, KDE
reversed exceptions, a setting that cannot be read, a script that cannot be fetched), the sessions stay on
`{ mode: 'system' }`. The settings are polled: Chromium's own answer every 2 seconds, the settings every 30 seconds, the
script every 30 minutes or when its URL changes (provisional numbers). The guard in
`src/main/route/verifier-name-guard.ts` stays registered as it is and remains the authority on whether a request for such
a name is sent.

## Context

Names Orivon serves are resolved inside the browser, never by the operating system or by a proxy.

A name the verifier serves (`.eth`, any other top-level domain a protocol serves, `.orivon`) is answered on this computer
through Chromium's `--host-resolver-rules`. A session in `{ mode: 'system' }` asks the system's proxy first, and that mode
takes no bypass list (`ProxyConfigDictionary::CreateSystem()`), so behind a proxy that GNOME or KDE settings, Windows or
macOS provide, the proxy would be asked to carry `CONNECT name.eth:443`, learn the name, and could answer a plain-http
request with a page of its own (T90). The guard cancels such a request before it is sent, and `no_proxy` exempts the names
from a proxy set only by environment variables (`src/main/verifier/no-proxy.ts`). Behind a desktop, Windows or macOS proxy
the names therefore do not open at all, and `docs/known-limitations.md` tells the person to add the suffixes to the
proxy's exceptions. Proxy tools that set the system proxy and switch it often make that advice a poor answer.

Measured in this repository on Linux (Electron 44.7.0, Chromium 152): a session in `fixed_servers` with the suffixes in
`proxyBypassRules` sends a name to the verifier and the ordinary sites to the proxy, the system's own exceptions kept; a
system script fetched, wrapped and set as a `data:` PAC keeps its per-host choice and opens the names; `pac_script` fails
closed (`ERR_MANDATORY_PROXY_CONFIGURATION_FAILED`) on a broken script; a change of `setProxy` applies at the next request
without closing connections; `setProxy` survives a network-service restart; a session in `fixed_servers` does not follow a
later change of the desktop setting, which a session in `system` mode does.

## Alternatives considered

- **Keep the guard alone, and the advice to edit the proxy's exceptions.** Safe, but the names never open behind these
  proxies, and the person has to change a system setting for one browser.
- **Read the effective config from Chromium's `netLog`.** It is the only API that shows it, but it writes only to a file,
  which holds the URL of every request every session makes while it runs; the config event appears only when a fresh
  session first resolves, so each read costs a session Electron never frees; the log is process-wide and its format is
  not documented. Kept as a test oracle only.
- **`{ mode: 'system', proxyBypassRules }`.** Chromium's system config takes no bypass list.
- **Call `WinHttpGetIEProxyConfigForCurrentUser`, Chromium's own Windows call, through PowerShell `Add-Type`.** The
  closest copy of what Chromium reads, but it compiles C# on each start, and Constrained Language Mode or AppLocker
  blocks it on managed machines, where proxies are most common. A native module is ruled out by Rule 8.
- **Repeat automatic detection (WPAD) in Orivon.** It would need DHCP on Windows, new lookups and fetches of `wpad`
  names, a well-known attack surface, and a second discovery that can disagree with Chromium's.
- **Turn every manual config into a PAC Orivon writes.** It loses Chromium's own bypass grammar (address ranges,
  `<local>`, the implicit loopback rules), and any bug in it fails every request of the session.
- **Watch the settings (`gsettings monitor`, `scutil` notifications, `RegNotifyChangeKeyValue`).** A long-lived child
  process per system for what an in-process question to the `system` session every 2 seconds already detects.
- **A local front that asks the `system` session per URL and forwards.** Every ordinary request would go through main,
  and the proxy's own sign-in (NTLM, Negotiate) would be lost.

## Reasoning

The copy reuses Chromium's own parsers: Windows' `ProxyServer` and `ProxyOverride` are already in the syntax
`setProxy` parses, and the rest maps onto it with explicit schemes. Chromium stays the judge of what the system means: a
session on `{ mode: 'system' }` keeps answering T20 and is the reference every applied config is checked against, so a
reader that is wrong, a desktop that is detected differently, or a setting the registry cannot show leaves the sessions
on the system's own config, which is the behaviour before this decision. The guard keeps asking each session which proxy
a name would take, so the copy cannot send a name to a proxy the guard would not see; for a copied script it removes the
guard's one residual, a script that answers `DIRECT` to the guard and a proxy to the request, because Orivon's prefix
answers before the script runs. Every part is JavaScript (Rule 8), and the parsers and the poller are pure over injected
commands, so each system's output is a unit fixture.

## Consequences

- "Follows the system live" becomes "mirrors it, polled": for about 2 seconds after the system's proxy is turned on,
  ordinary traffic in a mirrored session keeps the old config; an edit of the exceptions alone can take 30 seconds, and a
  change of a script's content at the same URL up to 30 minutes. T20 answers from the live `system` session and does not lag.
- Orivon makes a new request of its own: the fetch of the script the system names, direct, as Chromium fetches it in
  `system` mode, with no cookies or credentials, size and time caps, `http:` and `https:` only. It is a new row in
  `docs/architecture/egress.md`.
- Orivon runs `reg.exe`, `scutil` or `gsettings` (or reads `kioslaverc`) every 30 seconds; the raw output can hold a
  proxy password and is never logged. The bug report carries the source, the mode and the reason only.
- The route controller gains one dependency (the config a session that follows the system gets) and one method (apply it
  again); every apply runs in the session's turn and skips a session on a front or the dead end, so the tunnels (T84) are
  never overwritten. `app.setProxy` stays on `{ mode: 'system' }`.
- Orivon's direct requests and lookups move from the T20 session to a mirrored session of their own
  (`orivon-system-mirror`).
- What still refuses a name: the root-dot spelling of a name (`name.eth.`), which the resolver rules do not map to the
  verifier and so is given no exception (a rule that sent it direct would have Chromium resolve the name itself);
  automatic detection that finds a script, KDE reversed exceptions, Windows per-machine policy, an active dial-up or VPN connection with settings of its own, a script that answers at random, a script that
  cannot be fetched. `docs/known-limitations.md`, T90, T84, T20 and the egress section on these names change with the
  behaviour.
- Provisional until measured: that Chromium's PAC context runs `Function(...)` and reads an accessor `FindProxyForURL`
  (else the script is checked to parse on its own and concatenated). It is settled by the run the
  design names before the pull request that relies on it.
- Measured on a Windows runner for the Windows reader: Chromium takes the registry values when `ProxyEnable` is on, or off
  beside a `ProxyServer`, and the `DefaultConnectionSettings` blob otherwise, so a tool that writes only one form is followed;
  a `reg.exe` query takes about 26 ms and 14 ms of CPU, three are started per read, and the 30-second reads with the two-second
  question cost 0.6% of one core in all processes together (`src/main/route/proxy-mirror/README.md`, Design notes).
- Measured on a macOS runner for the macOS reader: Chromium reads the top level of the `scutil --proxy` dictionary only, the SOCKS
  server is SOCKS5, simple host names bypass the proxy only when "Exclude simple hostnames" is on, and a change made with
  `networksetup` shows in Chromium's answer within a tenth of a second (`src/main/route/proxy-mirror/README.md`, Design notes).
- Built in four pull requests, the order *provisional* until each lands. The first is the seam and changes no behaviour:
  the controller's `systemConfig` and `systemChanged`, the `orivon-system-mirror` session for Orivon's direct requests, and
  a CI rule that runs the system-proxy spec for the route files. The second reads GNOME and polls (GNOME manual proxies
  open the names); the third adds KDE, Windows and macOS; the fourth adds the script wrapper and the fetch. Until the
  second lands every session still follows the system, and the guard still refuses these names behind a proxy.

## Reversibility

- **Cost to reverse:** cheap. Making `systemConfig()` return `{ mode: 'system' }` again restores the earlier behaviour;
  the guard never stopped working.
- **What would make us revisit:** Electron offering a bypass list for `system` mode or an API that returns the effective
  proxy config; the canary check disagreeing on a measurable share of reports from real Windows machines (then the
  PowerShell call becomes a fallback); a script whose fetch by Orivon differs from Chromium's in a way the check cannot see.
