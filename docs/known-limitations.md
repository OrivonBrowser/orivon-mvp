# Known limitations

What Orivon does not do yet, or does in a way worth knowing before you rely on it. Each one is a
boundary of Orivon today, written down so you meet it here rather than in use. None is a bug.

## Network privacy

- **Peers see your IP address unless you route the app.** An app, a website or the whole browser can
  go through a tunnel: Nym, built in and the default, or your own SOCKS5 address, such as a Tor
  client's (Settings > Tunnels; an app's card in Apps; "Use the tunnel for this site" in a site's
  popup). Anything with no tunnel of its own, while the whole browser is not on one, connects from
  your real address, so a peer-to-peer app you have not routed shows it. A routed app resolves no
  name on this computer, cannot listen on your network and cannot look up an address by name. A
  Nym tunnel carries about 30 to 45 KB a second for each connection, with about a second of delay
  per round trip, so it suits what is private more than what is fast. Orivon's own requests (the update check,
  usage statistics you chose, search suggestions) and the local IPFS and Swarm nodes follow the
  tunnel only while "Send all of Orivon's traffic through the tunnel" is on. When a system proxy is set,
  an app that is not routed gets no `orivon.net` sockets and no name lookups, rather than going
  around it. [`architecture/egress.md`](architecture/egress.md) lists every path to the network
  and how each takes the tunnel.
- **The default secure DNS tells Quad9 the names you open.** Orivon looks site names up at Quad9
  over HTTPS, so the network you are on no longer sees them, and Quad9 does. When Quad9 cannot be
  reached the lookup goes to this computer's own DNS, so a network that blocks Quad9 still loads
  pages, and its owner sees the names again. Settings > Privacy picks another provider or turns it
  off. Sites you send through a tunnel are never looked up here, and `.eth` names are resolved
  apart from it.
- **No automatic port forwarding.** There is no UPnP, so behind NAT an app listening for peers is
  reachable only through a port you forward yourself.
- **No local peer discovery.** The manifest grammar has no multicast bind.
- **Text typed in the address bar that is not an address is searched on the Web3 or on the Web2.**
  The address bar's Web3 / Web2 button switches between them, and Settings > Search picks each
  engine. The Web3 search opens Explore (`explore.orivonstack.eth`) with the text after a `#` in
  its address, which a browser never sends to a server. The Web2 search goes to an engine on the
  web: DuckDuckGo by default, a short list or your own address in Settings. Suggestions from the
  Web2 engine as you type are off by default; switched on, each pause in typing sends the text,
  and a private window never sends it. The Web3 search gives no suggestions.
- **Spell-check dictionaries are downloaded from Chromium's dictionary host.** The download happens
  once per language, the first time that language is used while spell checking is on (Settings,
  on by default). The request names a language and nothing else.

## What `.eth` and IPFS reveal

Opening a `.eth` name or an `ipfs://` address is verified on your machine, and it still asks
servers for data. None of them is trusted to be right; each of them sees what it is asked.

- **The light client contacts Ethereum servers while `.eth` names are in use.** It starts when a
  `.eth` address is typed or opened and stops about ten minutes after the last one. It also runs
  once, two minutes after launch, when its newest checkpoint is more than seven days old. It
  follows the chain through `ethereum-beacon-api.publicnode.com` and one of three RPCs
  (`eth.drpc.org`, `rpc.mevblocker.io`, `ethereum-rpc.publicnode.com`).
- **Opening a name tells those RPCs the name.** The IPFS gateways (`ipfs.orbitor.dev`,
  `ipfs.filebase.io`, `trustless-gateway.link`) learn the content you fetch, and for some names
  `name.web3.storage`, a DNS-over-HTTPS resolver (`cloudflare-dns.com`, `dns.google`) or a server
  the name's own resolver chooses learns the name. Settings > Web3 lists them all.
- **Servers can withhold, not lie.** A server can refuse to answer or answer slowly. It cannot
  hand you a wrong name record or a wrong byte without the check failing. The light client's root
  of trust is a chain checkpoint shipped with each release.
- `ORIVON_ETH_LIGHT_CLIENT=off` switches the light client off for a run; no `.eth` name loads
  then.

## Apps

- **On a first visit, an app's own code starts before you answer its prompt.** Anything it asks
  for in that moment is refused; once you accept, the tab reloads and every later visit starts
  with the grant already held.
- **Only WebHID reaches a USB device.** WebUSB and Web Serial stay refused for every page. An app
  that needs them has no route to its hardware.
- **A device is asked about again when its identity changes.** An approval is kept for a device's
  vendor id, product id, serial number and name together, so a device that reappears with another
  product id (after unlocking, or after a firmware step) is asked once more.
- **Two units of one model with no serial number are one device.** An approval names a device by
  vendor id, product id, serial number and name, so two identical keys that report no serial number
  share it: approving one approves the other.
- **Native code runs only as WebAssembly.** A Node addon loads through its WebAssembly build and a
  spawned program is a WASI program from the app's own files. An app that needs a native binary
  or a program installed on your system is refused, by name.

## Packages

- **Windows and macOS packages are not signed with a bought certificate.** On Windows,
  SmartScreen warns on first run (**More info**, then **Run anyway**). On macOS the app is signed
  ad hoc and not notarized, so the first open is refused: choose **Open Anyway** in **System
  Settings > Privacy & Security**. Whether macOS 26 still offers Open Anyway for it, or calls it
  damaged with no way to open it, is unverified (*provisional*; a run on a real macOS 26 Mac
  settles it). The one-line Terminal install in the [README](../README.md#download) avoids the
  prompt entirely. [`development/packaging.md`](development/packaging.md) has the detail. Linux
  packages are not signed on any distribution. The Microsoft Store package is signed by the Store and
  never warned; an install from it is updated by the Store and looks for no update itself.

## Usage statistics

- **Nothing is measured or sent until you choose.** Usage statistics are a choice between two
  buttons, neither preselected; the exact text that would be sent is shown beside them. A private
  window neither measures nor sends.
- **Statistics and bug reports go to a small endpoint we run.** It is the one Orivon server a
  person can reach, it is used only after an explicit choice or a click on Send, and it is not in
  the path of using any app.
