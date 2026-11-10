# Known limitations

What Orivon does not do yet, or does in a way worth knowing before you rely on it. Each one is a
boundary of Orivon today, written down so you meet it here rather than in use. None is a bug.

## Network privacy

- **Peers see your IP address unless you route the app.** An app, a website or the whole browser can
  go through a tunnel: Nym, built in and the default, or your own SOCKS5 address, such as a Tor
  client's (Settings > Tunnels; an app's card in Apps; the tunnel button of a site or app in the
  address bar). Anything with no tunnel of its own, while the whole browser is not on one, connects from
  your real address, so a peer-to-peer app you have not routed shows it. A routed app resolves no
  name on this computer, cannot listen on your network and cannot look up an address by name. A
  Nym tunnel carries about 30 to 45 KB a second for each connection, with about a second of delay
  per round trip, so it suits what is private more than what is fast. Orivon's own requests (the update check,
  usage statistics you chose, search suggestions) and the local IPFS and Swarm nodes follow the
  tunnel only while "Send all of Orivon's traffic through the tunnel" is on. When a system proxy is set,
  an app that is not routed gets no `orivon.net` sockets and no name lookups, rather than going
  around it. [`architecture/egress.md`](architecture/egress.md) lists every path to the network
  and how each takes the tunnel.
- **Behind a proxy that a script Orivon cannot copy gives, or that automatic detection finds, `.eth` names and other Web3
  addresses do not open, even when the script would have let them through.** A name the verifier serves is answered on this
  computer, and a proxy that carried it would learn the name and could answer it with a page of its own. On Linux with a proxy set
  only by environment variables (`http_proxy` and the like) Orivon keeps these names out of it and they open. A
  tunnel keeps them out too. Behind a manual proxy in GNOME's settings (and in the desktops that share them: Unity,
  Cinnamon, Pantheon, Deepin, UKUI, COSMIC), in KDE's (read from the `kioslaverc` Chromium reads), in Windows' or in macOS's, Orivon copies the proxy's
  servers and exceptions into the sessions that follow the system, with the names it serves added to the exceptions, so they open and ordinary sites still go through the
  proxy. The copy is made only when a session of Orivon's own, set to it, answers as Chromium does for the same
  addresses; a proxy turned on, off or moved is followed within a few seconds, and an edit of the exceptions alone
  within thirty. Behind a proxy script the settings name (GNOME's, KDE's, Windows' or macOS's) or that `auto_proxy` names in the
  environment (on a desktop Chromium reads no proxy settings of its own for), Orivon fetches the script, wraps it
  so that the names it serves always go direct while every other name gets the script's own answer, and gives the sessions the
  wrapped copy under the same check. Chromium also reads `auto_proxy` when GNOME's or KDE's own settings give it no proxy to use
  (GNOME's manual mode with no server, KDE with no `kioslaverc` or no proxy type); a script there is left to the system, as the next paragraph says. Wherever the settings cannot be read or copied exactly, or the check disagrees, the sessions follow
  the system and the next paragraph applies; KDE's reversed exceptions are one such case, and so are a script that cannot
  be fetched (not at an `http:` or `https:` address, over a megabyte, not answering) and one that answers differently at every
  question, by the clock or at random. A name written with a dot at the end (`name.eth.`) is not found behind a copied proxy or script,
  and is refused behind any other. Where a script left to the system, automatic detection that finds one, or settings Orivon could not read or carry
  give the proxy, a session that follows the system cannot be told to leave a name out, and asking it which proxy it would use
  would run the system's script with the name, which the script could resolve or send anywhere. So Orivon does not ask: the request
  is refused before it is sent, and the tab says Orivon could not tell. That holds when the script would have answered
  "none" for the name, and for Orivon's own questions about a name too: an app that is not routed gets no lookup of and no connection to
  a name the verifier serves. Ordinary sites still go through the proxy. To open the names there, turn
  the system proxy off, give it a manual setting that lists `*.eth` and the other suffixes Orivon serves among its exceptions (the
  hosts that bypass it), or turn a tunnel on. Windows has "Automatically detect settings" ticked in a new installation, and the names open there while
  detection finds no script: Orivon asks Chromium which proxy it would use for two ordinary addresses, and detection counts as finding
  none while both answers are DIRECT, taken after the settings were last read and no more than ten seconds ago. A missing, late or
  other answer means detection may have found a script, and the names are refused as above. What that leaves open: a hostile network
  that serves a detection script answering DIRECT for every address is never noticed, and the script sees the names; each session runs
  its own detection, so between two samples a session may already have found a script the probe has not seen. A name asked for over plain `http:` is refused whatever the proxy is,
  except the developer names of a run that serves them. The settings are read every thirty seconds, and at once when Chromium's
  answer for an ordinary address changes: for the time between a script being turned on and that read, a session still on the system's own is asked,
  and the script then runs with the name. A copy follows the system by polling, not as it
  happens: for about two seconds after a proxy is turned on, ordinary traffic keeps the old setting, and the names are
  refused meanwhile.
- **Behind a proxy, the proxy looks up the names you open, unless you turn on "Look up site addresses in Orivon, not in your
  proxy" (Settings > Privacy and network, off by default).** The proxy then learns each site's name when a secure connection starts,
  and finds the address with its own DNS. With the setting on, Orivon looks the name up itself over HTTPS with your Secure DNS
  provider (Quad9 when Secure DNS is off or automatic), through the proxy, and asks the proxy to connect to the address; this computer's
  own DNS is never asked for those names. What that costs: names only your proxy can find, such as a company's internal sites, do
  not open unless they are among your system's proxy exceptions; a proxy that asks you to sign in does not work; a proxy that is on a
  port an anonymity network uses is refused (do not use it with Tor); Chromium's own DNS is held at this computer's DNS while it
  runs, so Secure DNS stops covering the hosts the system sends outside the proxy; calls and other peer-to-peer connections in sites go
  through the proxy and may not connect; sites the system sends outside the proxy, and a proxy script your system uses, are still
  looked up on this computer; for about two seconds after a proxy is turned on the sessions still follow the system.
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
  (`eth.drpc.org`, `rpc.mevblocker.io`, `ethereum-rpc.publicnode.com`), or through the servers you
  name in Settings > Web3. When the checkpoint it came with and the
  one it stored are both over 14 days old (or the beacon server answers 404 to the bootstrap of the one in use), it first asks `ethereum-beacon-api.publicnode.com` and
  `lodestar-mainnet.chainsafe.io` for a fresh one and uses it only if both give the same answer; if they do not,
  or one cannot be reached, no `.eth` name loads until a newer release is installed or they agree.
- **Opening a name tells those RPCs the name.** The IPFS gateways (`ipfs.orbitor.dev`,
  `ipfs.filebase.io`, `trustless-gateway.link`) learn the content you fetch, and for some names
  `name.web3.storage`, a DNS-over-HTTPS resolver (`cloudflare-dns.com`, `dns.google`) or a server
  the name's own resolver chooses learns the name. Settings > Web3 lists them all.
- **Servers you name are told the names, and the file keeps their keys.** With Your own servers
  chosen in Settings > Web3, only your servers are asked for what you fill in (a list or a
  beacon server you leave empty keeps Orivon's server for it), and when they fail `.eth` names
  wait: Orivon's servers are not asked in their place. A key in an address you typed is stored in your
  settings file as typed, since the file is not encrypted; Orivon hides it wherever it shows or
  records it, a private window held to Nym starts without your addresses, and an address on your
  home network over `http` sends its key in the clear on that network.
- **Servers can withhold, not lie.** A server can refuse to answer or answer slowly. It cannot
  hand you a wrong name record or a wrong byte without the check failing. The light client's root
  of trust is a chain checkpoint shipped with each release, or one fetched from two beacon servers that agreed
  (`ADR-0092`).
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

- **The Windows installer is not signed with a bought certificate.** SmartScreen warns on first
  run (**More info**, then **Run anyway**). The macOS apps in a release's dmgs are signed with an Apple
  Developer ID and notarized, so they open without a refusal; a package built from source with
  `npm run package:mac` is signed ad hoc, and its first open is refused until you choose **Open
  Anyway** in **System Settings > Privacy & Security**.
  [`development/packaging.md`](development/packaging.md) has the detail. Linux
  packages are not signed on any distribution. The Microsoft Store package is signed by the Store and
  never warned; an install from it is updated by the Store and looks for no update itself.

## Usage statistics

- **Nothing is measured or sent until you choose.** Usage statistics are a choice between two
  buttons, neither preselected; the exact text that would be sent is shown beside them. A private
  window neither measures nor sends.
- **Statistics and bug reports go to a small endpoint we run.** It is the one Orivon server a
  person can reach, it is used only after an explicit choice or a click on Send, and it is not in
  the path of using any app.
