# Privacy notice

Notice version: 2

Orivon Browser keeps your browsing on your computer. This page says what leaves it, why, and
what you can do about it. It is written for the person using the browser; the engineering list
behind it is [`outbound-requests.md`](outbound-requests.md), and an Italian version is
[`notice.it.md`](notice.it.md).

> **In five lines**
>
> - Telemetry is **your choice**: a checkbox on the first screen and a switch in Settings. Off
>   means nothing is measured and nothing is sent.
> - It counts **time**: how long the browser is in use, and how long on Web3, Web2.5 and other
>   sites. It names a site only when the site is a public Web3 or Web2.5 one.
> - It sends **no page addresses, no search text, no history, and your IP address is never written
>   to disk**.
> - It goes to **our own server** (`telemetry.orivonstack.com`), run by us, with no analytics
>   company in between.
> - You can **see exactly what is sent**, **turn it off at any time**, and **delete what we hold**
>   with one button.

## Who is responsible

The controller of the telemetry data is [CONTROLLER]. Write to [CONTACT] for anything in this
notice.

## What telemetry sends

Two messages leave, at most once a day each, and one more when you ask us to delete your data.
Settings > Privacy shows the literal text of each before and after it is sent.

| Field | Message | What it is |
|---|---|---|
| `schema` | all | The version of the message layout, a number |
| `installId` | usage report, erase request | An identifier for this computer, 32 characters. It comes from the operating system's machine ID run through a one-way hash, so it cannot be turned back into the machine ID. It is the same for every profile of the browser on this computer, and for a build run from source and an installed one. It is made only after you turn telemetry on |
| `stream` | usage report | A random value made once for each browser profile. Two profiles open at the same time are each counted, and added up as one computer by the install ID, so they are not two people |
| `region` | usage report | `EU`, `US` or `other`, worked out on your computer from its time zone. It is never taken from your IP address |
| `version` | usage report, site report | The version of Orivon Browser |
| `period` | usage report, site report | The month, such as `2026-10`. The message is a total for the month so far, sent again with a larger total on later days |
| `activeSec` | usage report | Seconds in the month you were using the browser: the window focused and you active |
| `backgroundSec` | usage report | Seconds in the month the browser was running without you using it |
| `classes.web3` | usage report | Of the active seconds, those on Web3 sites (fully verified, no server that can change what you get) |
| `classes.web25` | usage report | Of the active seconds, those on Web2.5 sites (partly verified) |
| `classes.web2` | usage report | Of the active seconds, those on ordinary Web2 sites. A total only; no site is named |
| `reportId` | site report | A random value made for each profile and each month. It is not your install ID, and the next month it is a new one |
| `sites` | site report | For each Web3 or Web2.5 site that has a public name, the active seconds in the month |

How `sites` is written. Each key is `web3:<name>` or `web25:<name>`, such as `web3:vitalik.eth`
or `web25:app.example.org`, and its value is a number of seconds. `<name>` is sent only when it is
public: a domain name, an ENS name, or a site the Web3 Score provider has judged. A site that has
only a raw content identifier, an IPNS key, or a local or private network address, and no judged
name, is added to its class total and listed as `(unlisted)`. Ordinary Web2 sites are never
written down, even on your computer: they exist only inside the `classes.web2` total.

What stays out, said plainly. No page addresses, no paths, no search text, no page titles, no
bookmarks, no passwords, no file names, no list of the order or the times of your visits, no
advertising identifier. The site report does name public Web3 and Web2.5 sites and the seconds
spent on each over a month; it is the closest thing to browsing information we send, so it is
kept apart from your install ID, as the table says.

Sent at most once a day. Nothing is sent from a development build, from a private window, or
when `ORIVON_TELEMETRY=off` is set. Nothing is sent before you choose. The browser ignores
everything the server answers: the server cannot change settings or send commands.

## Why, and on what basis

**Purpose.** To learn whether people actually use the browser, measured as active users, with
active meaning 25 hours a month, in Europe and the United States, and which kinds of site they
spend time on. We use it to decide what to build and to judge the project. We do not use it for
advertising, profiling or sale, and we give it to nobody.

**Legal basis.** Your consent: GDPR Article 6(1)(a). Reading the machine ID from your computer
and keeping an identifier on it also needs your consent under Article 5(3) of the ePrivacy
Directive, and the same checkbox gives it. In the EEA, the UK and Switzerland the box starts
unticked, because a box that is already ticked is not consent. Elsewhere it starts ticked, and
you can untick it before pressing Enter (provisional: the starting state may change before
release). You can withdraw at any time in Settings; withdrawing is as easy as agreeing, and
nothing in the browser gets worse for it. If you say no, we do not ask again for six months.

**Is an identifier personal data?** Yes, we treat it so. We cannot tell who you are from it, but
with it we can find your rows, which is why it is protected like personal data and why you can ask
us to delete them.

## What we keep, and for how long

- **Usage rows**, one per computer and profile and month: 12 months, then only totals that cannot
  be traced to a computer remain (the number of active users, the split by region and class).
- **Site reports**: a list of sites with seconds, kept for the month, then, one month after the
  month closes, folded into totals per site for all users together, and the individual reports
  deleted.
- **Your IP address**: not written to disk. The server's web front end does not keep an access
  log. A copy of your address is held in memory for a short time to slow down floods of
  requests, and is lost on restart.

## Who gets it, and where it goes

Nobody but us. There is no processor and no analytics company. The server is ours, self-hosted
at `telemetry.orivonstack.com` on a virtual server in the EU rented from OVH (provisional until
the hosting contract is confirmed). Nothing leaves the EU. If that changes this notice changes
first, and the version number above goes up, so your earlier consent stops counting and you are
asked again.

## Your rights

- **See what is sent.** Settings > Privacy shows both messages and a list of what has been sent.
- **Access** the rows we hold: write to [CONTACT] with the install ID shown in Settings.
- **Erase.** Press **Delete my data** in Settings: it asks the server to delete every row for your
  install ID, turns telemetry off, and says whether it worked. You can also write to [CONTACT]
  with your install ID. The site reports carry no install ID, so we cannot find yours among them;
  they leave as part of the totals described above.
- **Withdraw consent** at any time in Settings.
- **Object, correct, restrict, move.** Write to [CONTACT]; the data is only counters, so
  correction and moving have little to act on, but we will answer.
- **Complain** to a data protection authority. In Italy that is the Garante per la protezione dei
  dati personali, `garanteprivacy.it`; you may choose the authority of the country where you
  live or work.

## Everything else the browser sends by itself

Telemetry is the only thing that reaches a server of ours. The browser also makes requests of
its own to other servers, which we do not operate and from which we receive nothing. Each one
below is in [`outbound-requests.md`](outbound-requests.md) with the file that makes it.

| What | To whom | Why, and the basis | You can |
|---|---|---|---|
| Check for a new release | `api.github.com` | To tell you an update exists. Your consent: it is off until you switch it on in Settings > About | Switch it off |
| Follow Ethereum and prove `.eth` names | `eth.drpc.org`, `rpc.mevblocker.io`, `ethereum-rpc.publicnode.com`, `ethereum-beacon-api.publicnode.com` | To verify a name instead of trusting a server. Needed for the feature you asked for when you open a `.eth` or `ipfs://` address; two minutes after launch it also renews a checkpoint more than a week old (our legitimate interest, Article 6(1)(f), in the feature working). The RPC sees which `.eth` name you open | Switch the light client off in Settings > Web3 (then no `.eth` name loads) |
| Fetch the content of an `ipfs://` address or a `.eth` site, and look up `ipns://` keys and DNSLink names | `ipfs.orbitor.dev`, `ipfs.filebase.io`, `trustless-gateway.link`, `name.web3.storage`, `cloudflare-dns.com`, `dns.google`, and for some names a server that the name's own record chooses | To open the address you asked for. Performing what you asked, Article 6(1)(b). The server sees which content you open. Every block is checked against its hash | Not opening such addresses |
| Check an installed app for a new version while its tab is open | The same servers, every 30 minutes | To tell you when an app you installed has a new version. Our legitimate interest, Article 6(1)(f), in keeping apps current and safe; it repeats the lookups of the row above | Close the app's tab |
| Ask the Web3 Score provider about the page you are on | The provider set in Settings > Web3 (by default one chosen by Orivon, at an IPNS address) | To show a trust level in the site shield. Legitimate interest, Article 6(1)(f); on by default. The provider learns a bucket, 1 of 16 or 256, that the page's content identifier falls in, never the identifier or the address. A provider that knows few sites can guess which one a bucket means | Clear the provider address in Settings > Web3 |
| Fetch a page's icon | The site's own host, or a host the site names | To draw the tab icon. Performing what you asked, Article 6(1)(b); the same host that served the page | Not possible |
| Check Web Store extensions for updates | `update.googleapis.com` | To keep extensions you installed current and safe. Legitimate interest, Article 6(1)(f), and only if you installed one. It sends their identifiers, the Chromium version, your operating system, and two random identifiers. Never in a private window | Remove the extension |
| An extension's own downloads, such as filter lists | The hosts that extension names | Decided by the extension you installed | Settings of the extension, or remove it |
| Download a spell-check dictionary, once per language | Chromium's dictionary host | To check your spelling. Performing what you asked, Article 6(1)(b), and Settings says so | Switch spell checking off |

Three more send nothing until you switch them on in Settings: search suggestions as you type
(your typed text goes to your search engine; never in a private window), secure DNS (every
site name goes to the resolver you pick), and the Do Not Track and Global Privacy Control
signals, which send no data of their own.

We do not control what those servers do with the connection. They see your IP address, as any
server you connect to does, and they have their own privacy policies.

## Do Not Track and Global Privacy Control

Orivon Browser does not track you across sites and runs no advertising. When you switch on
**Do Not Track** or **Global Privacy Control** in Settings (both off in this build), the browser
adds `DNT: 1` and `Sec-GPC: 1` to the requests it makes to the sites you visit. Orivon's own
telemetry does not look at those signals: it follows the telemetry choice you make in the
browser, which is stricter, because it is always your explicit answer.

## Changes

When a message changes or a new one is added, the notice version at the top goes up. A consent
given under an earlier version stops counting, the browser asks again, and nothing is sent in
between.
