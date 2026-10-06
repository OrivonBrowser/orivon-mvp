# Outbound requests: everything Orivon sends that the person did not type

This page lists every network request the browser makes on its own: not a page the person
opens, not a download they start, not an app's own traffic. It is an engineering inventory; the
people-facing version is [`notice.md`](notice.md), which must cover every row here. A new
background request is added here in the same change that makes it.

**reveals site** marks a request that tells a server which site the person is visiting, whole or
in part. Everything unmarked leaves no trace of the sites visited.

Every request below leaves from the person's own computer, so its destination also sees the IP
address of the connection. That is true of any request and is not repeated per row.

## The inventory

| # | Flow | What leaves | To whom | When | Reveals the visited site | How to turn it off | Code |
|---|---|---|---|---|---|---|---|
| 1 | Telemetry: usage report | Install ID, stream, region, version, month, active and background seconds, seconds per site class | `telemetry.orivonstack.com` | When the person turns telemetry on, about once a day, when the browser quits, and once more at the start of a month to close the previous month; only after the person turned telemetry on; never in a development build or a private window | No | Settings switch; `ORIVON_TELEMETRY=off` for a run | `src/telemetry/runner.ts`, `src/telemetry/transport.ts` |
| 2 | Telemetry: site report | Install ID, stream, version, month and seconds per named Web3 or Web2.5 site, for the month so far | `telemetry.orivonstack.com` | Same as row 1, each daily send at its own random offset | **reveals site**: the sites named, linked to the install ID for the month and the month after, then kept only as totals with no ID; the server sees the same IP as for row 1 | Same switch | `src/telemetry/runner.ts` |
| 3 | Update check | Nothing but a GET for the latest release; the request carries a user agent naming the repository | `api.github.com` | At launch, then hourly while the browser is open, kept to once a day by the stored time of the last answer | No | Settings > About, `updates.check` (off by default); a private window never asks | `src/main/self-update/update-check-runner.ts:27`, `:81`; `update-schedule.ts:19`; `src/main/index.ts:221`; `src/main/settings/schema.ts:82` |
| 4 | Ethereum light client: execution RPC | JSON-RPC calls and proof requests that follow the chain; while a `.eth` name loads, the calls that read that name's resolver and records | `eth.drpc.org`, `rpc.mevblocker.io`, `ethereum-rpc.publicnode.com` (one at a time, failing over) | While the verifier host runs: started by a `.eth` or `ipfs://` request or an open tab on one, put to sleep 10 minutes after the last need; also once, 2 minutes after launch, when the stored checkpoint is more than 7 days old (not in a private window) | **reveals site** for a `.eth` name: the name's lookup is visible to the RPC. Chain-following alone is not | `web3.lightClient` in Settings (read at start; then no `.eth` name can be verified); `ORIVON_ETH_LIGHT_CLIENT=off` for a run | `src/main/verifier/endpoints.ts:9`; `src/protocols/verifier-host/protocols.ts:81`; `src/protocols/verifier-host/light-client/rpc-failover.ts:33`; `src/main/verifier/host-lifecycle.ts:2-12`; `src/main/settings/schema.ts:84` |
| 5 | Ethereum light client: beacon API | Light-client sync requests | `ethereum-beacon-api.publicnode.com` | Same as row 4 | No | Same as row 4 | `src/main/verifier/endpoints.ts:10` |
| 6 | IPFS gateways | A request for each block of the content (`/ipfs/<cid>`), the content identifier of the page | `ipfs.orbitor.dev`, `ipfs.filebase.io`, `trustless-gateway.link` (the first, a hedge to the next after a delay) | When the person opens an `ipfs://` address or a `.eth` name that points to IPFS content, and for an installed app's update watch (row 11) | **reveals site**: the content identifier, which names the site | Cannot be switched off on its own; not opening `ipfs://` and `.eth` addresses sends none. Every block is checked against its hash, so a gateway is trusted for availability only | `src/main/verifier/endpoints.ts:13`; `src/protocols/ipfs/gateways.ts:168`; `src/protocols/verifier-host/protocols.ts:64` |
| 7 | IPNS lookup | The IPNS key being resolved | The gateways of row 6 and `name.web3.storage` | When an `ipns://` address, or a name that points to one, is opened; also row 11 | **reveals site**: the key names the site | As row 6 | `src/protocols/ipfs/ipns.ts:42`, `:70`; `src/main/verifier/endpoints.ts:14` |
| 8 | DNS over HTTPS (verifier) | A TXT query for `_dnslink.<domain>`, and, only after a gateway failed and the system resolver's answer disagreed, A and AAAA queries for that gateway | `cloudflare-dns.com`, `dns.google` | When an address names a domain whose DNSLink is read; the gateway comparison only after a gateway failure | **reveals site** for the DNSLink query: the domain. The gateway comparison names a gateway, not a site | As row 6 | `src/main/verifier/endpoints.ts:15`; `src/protocols/verifier-host/doh.ts:70`, `:88`; `src/protocols/verifier-host/protocols.ts:51`; `src/protocols/verifier-host/dns-fallback.ts` |
| 9 | Offchain name resolvers (CCIP-Read) | The query a `.eth` name's resolver contract asks to be sent: the name and the record asked for | A server the name's own resolver contract names (https, port 443, public addresses only) | When a `.eth` name whose resolver uses an offchain lookup is opened | **reveals site**: the `.eth` name | As row 6 | `src/protocols/verifier-host/egress.ts:144` |
| 10 | Web3 Score provider | First a description file of the provider, then the file of one hash bucket (`website/<bucket>.json`), the first one or two hex characters of the SHA-256 of the page's content identifier. Never the identifier, name or address | The provider the person set; by default the Orivon-chosen provider at an IPNS address, reached through rows 6 and 7 | When the site shield or site popover assesses a page whose files Orivon verified (a content identifier or bundle hash exists), and when a page holding the `trust.score` grant asks about sites; answers are kept 10 minutes | **reveals site** in part: 1 of 16 or 256 buckets. A provider that knows few sites can guess which one a bucket means (`docs/architecture/web3-score-provider.md` §What the provider learns) | Settings > Web3, `web3.scoreProvider`; empty asks nobody | `src/main/browsing/score-provider-client.ts:46`, `:92`, `:136`; `src/main/permissions/site-info-controller.ts:157`; `src/main/settings/schema.ts:11`, `:86` |
| 11 | Installed-app update watch | The same lookups as rows 4 and 6 to 9, for the name an installed app lives at | As rows 4 and 6 to 9 | Every 30 minutes for each open tab of an installed app reached at a name | **reveals site**: the same sites, again, while their tabs stay open | Cannot be switched off on its own; closing the app's tab stops it | `src/main/install/update-watch.ts:12`, `:19`; `src/main/install/app-install-subsystem.ts:138` |
| 12 | Tab icons | A GET for each icon the page declares (at most a few), or `/favicon.ico` | The page's own host, or the host the page names for its icon | When a page is shown, after it loads | No new recipient: the same host the page was loaded from, or a host the page itself named. Through rows 6 and 7 for `ipfs://` pages | Cannot be switched off | `src/main/browsing/favicon.ts:308` |
| 13 | Extension update check | The identifiers of the Web Store extensions installed, the browser's Chromium version, operating system and architecture, a random request ID and a random session ID | `update.googleapis.com` | Only when a Web Store extension is installed: at start, on a window gaining focus (at most every 3 hours) and every 5 hours; not while the computer is idle; never in a private window | No | Cannot be switched off on its own; removing the extension stops it. Provisional: a setting for it is not decided | `vendor/electron-chrome-web-store/src/browser/updater.ts:68-69`, `:126`, `:154`, `:363-387`; `src/main/extensions/store-runner.ts:127` |
| 14 | Extension's own requests (filter lists and the like) | Whatever the extension asks for, such as an ad blocker fetching its filter lists | The hosts that extension names, within the host permissions the person granted it | By the extension's own schedule | No for filter lists. The extension decides; Orivon does not read the traffic. Provisional: not measured here | The extension's own settings, or remove it | `src/main/extensions/` (no Orivon code issues these) |
| 15 | Spell-check dictionaries | A download of a dictionary, once per language | Chromium's dictionary host; the address is Chromium's, not set in Orivon's code | On first use of a language while spell checking is on | No; it names a language | Settings, `spellcheck.enabled` (on by default) | `src/main/spellcheck/spellcheck.ts:19`; `src/main/spellcheck/README.md`; `src/main/settings/schema.ts:103` |

## Switched on by the person

These send nothing until the person changes a setting; when they do, the destination is named in
Settings.

| Flow | What leaves | To whom | Reveals the visited site | Setting | Code |
|---|---|---|---|---|---|
| Search suggestions | The text typed in the address bar, after a short pause, when it is a plain search (not an address, not a keyword search); never in a private window; no cookie, no referrer | The default search engine's suggestion address | No: the typed search text, not a site | `search.suggestions`, off by default | `src/main/omnibox/suggest-fetch.ts:54`; `src/main/omnibox/suggest-net.ts:6`; `src/main/browsing/search-engines.ts:20-27`; `src/main/settings/schema.ts:46` |
| Secure DNS | Every host name a page needs | Cloudflare, Quad9, or the system's automatic upgrade | **reveals site**: every host name looked up, to the chosen resolver; the person chose it as a trade for the local network not seeing the names | `privacy.secureDns`, off by default | `src/main/privacy/secure-dns.ts:12-13`; `src/main/settings/schema.ts:60` |
| Do Not Track and Global Privacy Control | A `DNT: 1` header, and `Sec-GPC: 1` with `navigator.globalPrivacyControl` | The sites the person visits | It is a signal on requests and pages the person already loads; no new request | `privacy.doNotTrack` (off by default), `privacy.globalPrivacyControl` (on by default) | `src/main/privacy/privacy-headers.ts`; `src/main/privacy/gpc-switch.ts`; `src/main/settings/schema.ts:57-58` |

## Not a request of Orivon's own

- **Google sign-in.** On `accounts.google.com` and `accounts.youtube.com` the browser rewrites the
  headers of the person's own requests so the page sees a different browser identity. It sends
  no request of its own (`src/main/shell/sign-in-identity-headers.ts`).
- **Web Store install.** Installing an extension downloads it from the Chrome Web Store, after
  the person pressed Install (`src/main/extensions/store-download-seam.ts:35`).
- **App install and load.** An app's files are fetched when the person opens or installs it.
  That is a page load, not a background request.
- **Chromium's own services.** Orivon's code starts no Safe Browsing, component updater, sync or
  crash-report upload. Whether the Electron build contacts a Google service on its own is read
  from packet captures, not from source; the release checklist's traffic observation is where it
  is verified (`docs/development/release-checklist.md`).

## What is not listed because it does not exist

No analytics SaaS, no crash reporter, no advertising identifier, no remote configuration. The
client ignores the body of every response from the telemetry server, so the server cannot change
what the browser does.
