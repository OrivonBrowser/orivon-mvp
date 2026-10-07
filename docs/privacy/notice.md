# Privacy notice

Notice version: 4

Orivon Browser keeps your browsing history on your computer. This page says what leaves it, why, and
what you can do about it. It is written for the person using the browser; the engineering list
behind it is [`outbound-requests.md`](outbound-requests.md), and an Italian version is
[`notice.it.md`](notice.it.md).

> **In five lines**
>
> - Telemetry is **your choice**: a window asks as you enter, with two equal buttons, and Settings has
>   a switch. Off means nothing is measured and nothing is sent.
> - It counts **time**: how long the browser is in use, and how long on Web3, Web2.5 and other
>   sites. It names a site only when the site is a public Web3 or Web2.5 one.
> - It sends **no page addresses, no search text, no history, and your IP address is never written
>   to disk**.
> - It goes to **our own server** (`telemetry.orivonstack.com`), run by us, with no analytics
>   company in between.
> - You can **see exactly what is sent**, **turn it off at any time**, and **delete what we hold**
>   with one button.

Bug reports are separate from telemetry: one leaves only when you write it and press Send. See
[Bug reports you send](#bug-reports-you-send).

## Who is responsible

The controller of the telemetry data and of the bug reports you send is Davide Martinico, a
natural person, the owner of the project. Write to privacy@orivonstack.com for anything in this notice.

## What telemetry sends

Two messages leave: when you turn telemetry on, when you start and when you quit the browser, about once a day in between, and once more at the start of a month to close the previous month's totals. One more message leaves when you ask us to delete your data.
Settings > Privacy shows the literal text of each before and after it is sent.

| Field | Message | What it is |
|---|---|---|
| `schema` | all | The version of the message layout, a number |
| `installId` | usage report, site report, erase request | An identifier for this computer, 32 characters. It comes from the operating system's machine ID run through a one-way hash, so it cannot be turned back into the machine ID. It is the same for every profile of the browser on this computer, and for a build run from source and an installed one. It is made only after you turn telemetry on. The site report carries it too, so that reports a program forged can be told from yours |
| `stream` | usage report, site report | A random value made once for each browser profile. Two profiles open at the same time are each counted, and added up as one computer by the install ID, so they are not two people |
| `country` | usage report | The country of your computer's time zone, as a two-letter code such as `IT` or `US`, worked out on your computer from the time zone setting; `unknown` when the time zone names no country, such as `UTC`. It is the time zone's country, not proof of where you are, and it is never taken from your IP address |
| `version` | usage report, site report | The version of Orivon Browser |
| `period` | usage report, site report | The month, such as `2026-10`. The message is a total for the month so far, sent again with a larger total on later days |
| `activeSec` | usage report | Seconds in the month you were using the browser: the window focused and you active |
| `backgroundSec` | usage report | Seconds in the month the browser was running without you using it |
| `classes.web3` | usage report | Of the active seconds, those on Web3 sites (fully verified, no server that can change what you get) |
| `classes.web25` | usage report | Of the active seconds, those on Web2.5 sites (partly verified) |
| `classes.web2` | usage report | Of the active seconds, those on ordinary Web2 sites. A total only; no site is named |
| `sites` | site report | For each Web3 or Web2.5 site that has a public name, the active seconds in the month |

How `sites` is written. Each key is `web3:<name>` or `web25:<name>`, such as `web3:vitalik.eth`
or `web25:app.example.org`, and its value is a number of seconds. `<name>` is sent only when it is
public: a domain name, an ENS name, or a site the Web3 Score provider has judged. A site that has
only a raw content identifier, an IPNS key, or a local or private network address, and no judged
name, is added to its class total and listed as `(unlisted)`. Whether a name is public is judged
by its form, not looked up: a Web2.5 site at an internal name under a public domain, such as
`intranet.example.com`, would be named. Ordinary Web2 sites are never
written down, even on your computer: they exist only inside the `classes.web2` total.

What stays out, said plainly. No page addresses, no paths, no search text, no page titles, no
bookmarks, no passwords, no file names, no list of the order or the times of your visits, no
advertising identifier. The site report does name public Web3 and Web2.5 sites and the seconds
spent on each over a month; it is the closest thing to browsing information we send. It is sent under your install ID, so
the sites you spend time on are linked to that ID for the month and the month after, and then
kept only as per-site totals with no ID, as the next section says.

Sent when you turn telemetry on, when you start and when you quit the browser, about once a day in between, and at the start of a month once more to close the previous month's totals. Nothing is sent from a development build, from a private window, or
when `ORIVON_TELEMETRY=off` is set. Nothing is sent before you choose. The browser ignores
everything the server answers: the server cannot change settings or send commands.

## Why, and on what basis

**Purpose.** To measure how many people use Orivon actively and on which kinds of site they
spend time. We use it to decide what to build and to judge the project. We do not use it for
advertising, profiling or sale, and we give it to nobody.

**Legal basis.** Your consent: GDPR Article 6(1)(a). Reading the machine ID from your computer
and keeping an identifier on it also needs your consent under Article 5(3) of the ePrivacy
Directive, and the same answer gives it. When you press **Enter Orivon** on the first screen, a
window titled **Support us for free through telemetry** opens over the browser, with two buttons
of the same look and size, **Accept** and **Deny**. Neither is preselected, and you must press one
to enter; so your answer is a clear act, not a box left as it was found. The window is shown only
while you have not answered. You can
change your mind at any time with the switch in Settings; withdrawing is as easy as agreeing,
and nothing in the browser gets worse for it. If you answered no, nothing asks you again for six
months. If you agreed and this notice later changes what is sent, nothing is sent under the new
version until you answer again: the next time Orivon starts, the same window asks you, with a
line saying what changed.

**Is an identifier personal data?** Yes, we treat it so. We cannot tell who you are from it, but
with it we can find your rows, which is why it is protected like personal data and why you can ask
us to delete them.

## What we keep, and for how long

- **Usage rows**, one per computer and profile and month: 12 months, then only totals that cannot
  be traced to a computer remain (the number of active users, the split by country and class).
- **Site reports**: a list of sites with seconds, with your install ID, kept for the month, then,
  one month after the month closes, folded into totals per site for all users together, and the
  individual reports deleted. Until then each row carries your install ID; afterwards no ID.
- **Reports that look forged**: site seconds that a usage report does not account for are not
  counted. An install ID found sending forged reports is deleted and refused for 12 months, then
  taken off the list. Our legitimate interest in accurate statistics, Article 6(1)(f), is the
  basis.
- **Your IP address and User-Agent**: not written to disk. The web front end that terminates the
  encrypted connection keeps no access log. Your address is held in memory only, to limit each
  address to 30 requests in 10 minutes, and is lost on restart.
- **Time of receipt**: only the UTC day is stored with a row, not the time.

## Who gets it, and where it goes

Nobody but us. There is no processor and no analytics company. The server is ours, at
`telemetry.orivonstack.com`, on a virtual server rented from OVH SAS in Strasbourg, France. Its
rows are in a database on that server. Telemetry data never leaves the EU (a bug report you send
can: see [Bug reports you send](#bug-reports-you-send)). If that changes this notice changes
first, and the version number above goes up, so your earlier consent stops counting until you
turn telemetry on again. The server's source code is not published; this notice is the description of what it
stores and for how long.

## Your rights

- **See what is sent.** Settings > Privacy shows both messages and a list of what has been sent.
- **Access** the rows we hold: write to privacy@orivonstack.com with the install ID shown in Settings.
- **Erase.** Press **Delete my data** in Settings: it asks the server to delete every usage row
  and every site report for your install ID, turns telemetry off, and says whether it worked. You
  can also write to privacy@orivonstack.com with your install ID. Per-site totals already folded
  together for all users carry no ID, so yours cannot be found among them.
- **Withdraw consent** at any time in Settings.
- **Object, correct, restrict, move.** Write to privacy@orivonstack.com; the data is only counters, so
  correction and moving have little to act on, but we will answer.
- **Complain** to a data protection authority. In Italy that is the Garante per la protezione dei
  dati personali, `garanteprivacy.it`; you may choose the authority of the country where you
  live or work.

## Bug reports you send

A bug report is separate from telemetry. It leaves only when you write one and press **Send**,
with telemetry on or off, and pressing Send once sends that one report and nothing later. You open
the form with **Report a problem** in the menu, with the **Report** button on a tab that crashed,
or from the bar Orivon shows after it closed unexpectedly. The form shows the literal text of the
report before you send it, and a box for each part you can leave out.

| Field | What it is |
|---|---|
| `schema` | The version of the message layout, a number |
| `reportId` | A random identifier made with the report, shown in the form's preview and again after sending so you can refer to the report. It is not linked to the telemetry install ID or to anything else on your computer |
| `description` | What you wrote about the problem |
| `contact` | How to reach you, if you wrote it: an email address, or a name on GitHub or Matrix. Empty if you did not |
| `version` | The version of Orivon Browser |
| `crash.kind` | When the report is about a problem Orivon recorded: whether Orivon itself hit an error, a page or another part of Orivon stopped, or Orivon closed unexpectedly. The whole `crash` part is empty when you choose no recorded problem |
| `crash.at` | When that happened, to the second, in UTC |
| `crash.process` | Which part stopped, such as `main`, `tab` or `GPU` |
| `crash.reason` | The reason the system gave, such as `crashed` or `oom` (out of memory) |
| `crash.exitCode` | The exit code of the process that stopped, a number |
| `crash.message` | The error message, if there was one |
| `crash.stack` | Where in Orivon's code the error happened (the call stack) |
| `diagnostics` | Technical details, sent when **Technical details** is ticked, as it is when the form opens. What it holds is listed below |
| `log` | The last lines Orivon wrote to its own log, at most 1,000, sent when **Recent log** is ticked, as it is when the form opens, except in a private window, where it starts unticked. A line can name a page or a file Orivon was working with |
| `page` | The address of the page that crashed, sent only if you tick **The crashed page's address**. Never offered for a private window |
| `dump.base64` | The crash dump, sent only if you tick **The crash dump**: a snapshot of the memory of the process that crashed, at most 5 MB. It can hold fragments of the pages that were open, including what you typed into them. Unlike the rest, the form cannot show its contents |
| `dump.bytes` | The size of the crash dump |

What `diagnostics` holds: the build of Orivon (its source revision and how it was installed), the
Electron, Chromium, Node.js and V8 versions, and how long Orivon had been running; the operating
system and its version, the processor type and count, the memory installed and free, the
language, and the desktop session (X11 or Wayland, and the desktop's name); the graphics card's
vendor and device numbers, its driver version, and which graphics features are on; the size and
scaling of each screen; how much memory each kind of Orivon process uses; how many windows and
tabs are open, and whether the window is private; your installed extensions (name, identifier,
version, on or off); the values of a few settings that change how Orivon behaves (theme, cookies,
Global Privacy Control, Do Not Track, HTTPS-only, the secure DNS mode, memory and energy saver,
start-up mode, spell checking, developer tools, extension developer mode, update checks, the
Ethereum light client, and opening `.eth.limo` addresses as `.eth` names), never an address or a
folder; and the last ten problems Orivon recorded (kind, time, process, reason,
exit code), without their messages or addresses. In every part of a report, the path of your home
folder is replaced by `~`.

**Why, and on what basis.** To find and fix the problem you report. Your consent, GDPR Article
6(1)(a): you write the report, see what it holds, and press Send; without that nothing leaves.

**Who reads it.** The maintainers. To find the cause, they may give a report to an AI coding
assistant, today Claude, made by Anthropic PBC in the United States, which then processes it on
our behalf. That is a transfer outside the EU; the form says so next to the Send button, and
pressing Send is your explicit agreement to it (GDPR Article 49(1)(a)). The risk is the one of
any transfer to the United States: its authorities may have access to data held there, under
rules that differ from the EU's. Nobody else receives a report.

**What we keep, and for how long.** The report as sent, on the same server as telemetry, 90 days
from the day it arrives, then deleted with its crash dump. Only the UTC day is stored with it. Your
IP address is not written to disk; it is held in memory only, to limit each address to 6 reports
an hour. The browser reads nothing of the server's answer except whether the report arrived.

**Your rights.** The form lists the reports you sent, each with **Delete from server**, which
deletes it and its crash dump at once. You can also write to privacy@orivonstack.com with the
report ID, for access, deletion or anything else; the rights and the complaint route in
[Your rights](#your-rights) apply to reports too.

**What stays on your computer.** So that a report can say what went wrong, Orivon keeps, in its
own profile folder: its log of this run and of the previous one, a record of the last 30
problems (from the last 30 days), and up to 10 crash dumps from the last 30 days. None of it
leaves unless you send a report that includes it. A private window's records go when it closes.

## Everything else the browser sends by itself

Telemetry, and the bug reports you choose to send, are the only things that reach a server of
ours. The browser also makes requests of its own to other servers, which we do not operate and
from which we receive nothing. Each one below is in [`outbound-requests.md`](outbound-requests.md) with the file that makes it.

| What | To whom | Why, and the basis | You can |
|---|---|---|---|
| Check for a new release | `api.github.com` | To tell you an update exists. Your consent: it is off until you switch it on in Settings > About | Switch it off |
| Follow Ethereum and prove `.eth` names | `eth.drpc.org`, `rpc.mevblocker.io`, `ethereum-rpc.publicnode.com`, `ethereum-beacon-api.publicnode.com` | To verify a name instead of trusting a server. Needed for the feature you asked for when you open a `.eth` or `ipfs://` address; two minutes after launch it also renews a checkpoint more than a week old (our legitimate interest, Article 6(1)(f), in the feature working). The RPC sees which `.eth` name you open | Switch the light client off in Settings > Web3 (then no `.eth` name loads) |
| Fetch the content of an `ipfs://` address or a `.eth` site, and look up `ipns://` keys and DNSLink names | `ipfs.orbitor.dev`, `ipfs.filebase.io`, `trustless-gateway.link`, `name.web3.storage`, `cloudflare-dns.com`, `dns.google`, and for some names a server that the name's own record chooses | To open the address you asked for. Performing what you asked, Article 6(1)(b). The server sees which content you open. Every block is checked against its hash | Not opening such addresses |
| Check an installed app for a new version while its tab is open | The same servers, every 30 minutes | To tell you when an app you installed has a new version. Our legitimate interest, Article 6(1)(f), in keeping apps current and safe; it repeats the lookups of the row above | Close the app's tab |
| Ask the Web3 Score provider about the page you are on | The provider set in Settings > Web3 (by default one chosen by Orivon, at an ENS name) | To show a trust level in the site shield. Legitimate interest, Article 6(1)(f); on by default. The provider learns a bucket, 1 of 16 or 256, that the page's content identifier falls in, never the identifier or the address. A provider that knows few sites can guess which one a bucket means | Clear the provider address in Settings > Web3 |
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

Orivon Browser does not track you across sites and runs no advertising. **Global Privacy
Control** is on unless you turn it off in Settings: every site you visit gets `Sec-GPC: 1` on its
requests and reads `navigator.globalPrivacyControl` as `true`, which asks it not to sell or share
your data. **Do Not Track** is off unless you turn it on; then the browser adds `DNT: 1`. Orivon's own
telemetry does not look at those signals: it follows the telemetry choice you make in the
browser, which is stricter, because it is always your explicit answer.

## Changes

When a telemetry message changes or a new one is added, the notice version at the top goes up. A
consent given under an earlier version stops counting: nothing is sent until you turn telemetry
on again in Settings. A bug report is not under that consent: you give it for each report, with
the whole report in front of you, so a change to what a report holds is written here and shown
in the form, without the version going up.
