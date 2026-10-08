# Roadmap

Where Orivon is and where it is going. Nothing under "Expected next" or "Later" is a promise or has
a date. A feature is built when a real app, a person or a roadmap item calls for it, and its line
moves to [`features.md`](features.md) when it lands.

## Now

What works today is in [`features.md`](features.md), one line per feature, and in
[`planning/compatibility-matrix.md`](planning/compatibility-matrix.md), which says what a ported
app can rely on. [`known-limitations.md`](known-limitations.md) says what each feature does not do.

Orivon is a product in early access. It is a browser to live in and a platform that runs
applications a web page cannot be, and both are in use now.

## Expected next

- A native wallet is on the way.
- Signed self-update: the check runs by default, installing always waits for the person's
  "Yes, install", and a manual download path is always offered.
- Orivon Explore as a directory of apps.
- More ported apps.

## Later

- Mobile.
- Cross-device sync.
- Stronger sandboxing of untrusted apps. Today's model is authorisation, not containment.
- Native desktop apps rendered in a tab, such as Bisq (compatibility tier 3).
- Deeper WASI and WebAssembly support inside the layer that runs apps today.
- Spell-check dictionaries served from `.eth` names.
- Orivon as the system's handler for a link scheme or a file type, so a link clicked in another program, or a `.torrent` file, opens in an app.
- Windows and macOS code signing with bought certificates.
- Web3 search.
- Tor and proxy chains.
- Arweave, and content-addressed stores other than IPFS.
- DDOC anchored in DNS.
- A reading list, address autofill, and a device chooser for WebUSB.
- Identity export and backup.
- Ideas, not scheduled: a BitTorrent streaming app ([`planning/torrent-app.md`](planning/torrent-app.md))
  and Nostr identity as `window.nostr`.
- Full nodes such as Bitcoin Core running as sites.

## Non-goals

- No Orivon server in the path of using it. Infrastructure is limited to the endpoint for opt-in
  statistics and bug reports, and static hosting of first-party app bundles.
- No judged score passed off as a machine-verified one. The indicator keeps what the machine
  observed apart from what a provider attests, and names the provider behind every judged level.
- No native machine code run for an app. Native modules and child processes run as WebAssembly.
