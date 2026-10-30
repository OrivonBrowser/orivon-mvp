# ADR-0104: The tunnel button sets the tab or the browser, and a website's own tunnel is made by one explicit switch

- **Status:** accepted. Extends [`ADR-0101`](ADR-0101-a-tab-can-carry-a-tunnel-choice-that-holds-for-every-website-it-opens.md) (a tab carries a choice) to every website in a tab, and changes [`ADR-0089`](ADR-0089-each-website-and-app-picks-its-own-tunnel-and-an-installed-apps-tunnel-is-set-as-a-websites-is.md) in one respect: a website's entry is no longer made by the tunnel button's rows.
- **Date:** 2026-10-30
- **Type:** product / architecture
- **Decided by:** owner (the button sets the tab, or the browser, and a website's own entry is made only by an explicit "Always use for this site" switch); AI recommendation accepted by default for the rest, marked *provisional* below

## Decision

**The tunnel button's list is about the tab on every website, not only on a tab that carries a choice.** Its first panel is "This tab" for a new tab and for every website in a tab, whether or not the tab has a choice and whether or not the website has an entry of its own. It stays "This app" on an installed app's page, and it is about the page, as before, on a page in a session an app or a temporary route made for it, on a page of this computer or anything else that cannot go through a tunnel, and on a page of the shell.

**A row sets the tab, never the website.** Moving a row sets the tab's choice (Nym, the proxy or direct, as ADR-0101 has it) and writes nothing about the website: no entry in `routes.json`, no record of storage kept apart for it. The choice is gone when the tab closes. The rows show what the page really does: the tab's choice over the website's entry (ADR-0101's table), else the entry, else the browser's tunnel. The first move of a website into a profile still shows the storage notice, and a failed move gives the choice back.

**"Always use for this site" saves what the panel shows as the website's own choice.** It is the only way the button makes an entry. It is on exactly while the website has an entry, and held while nothing is chosen. Turned on, the entry becomes the tab's choice (a `direct` choice while the browser is on a tunnel is an `off` entry) and nothing else changes or loads. Turned off, a tab with no choice first takes the entry's tunnel as its own (an `off` entry becomes `direct`), then the entry is removed, so nothing visibly moves. While it is on, a row moved changes the entry and the tab together, and the lit row turned off clears both, since the tab's choice would otherwise win over the entry (ADR-0101). The two steps of each change are in the order that fails closed: the tab first, because moving it is what can fail, then the entry; an entry that cannot be saved gives the tab back what it had.

**The tab is fixed at construction, and the popup can never name the website that acts.** The popup is opened for one tab. The website a command is about is read from that tab in the main process at the moment the command arrives; what the popup sends as the website it shows (`shownOrigin`) is only a check that it still shows it, and a command whose check fails is refused. "Always use for this site" is refused when the check fails, in a window held to Nym, while the settings cannot be read, and for an origin that cannot go through a tunnel; a row moved on a website that has an entry is refused when the check fails. A popup that shows a tab whose first page arrives is not closed by the arrival.

**The switch names both tunnels when the tab goes another way than the entry.** A tab's choice beats the website's entry (ADR-0101), so the panel can show Nym lit while the website is saved for the proxy. Always is then on, and its line says what is saved and what the tab uses; turning it off removes the saved entry, and a row moved with it on replaces it. A switch that is held (a window held to Nym, settings that cannot be read) says nothing it cannot keep. Turning Always off leaves the page's service workers in the session the tab still runs it in.

**Which panel opens.** A website with an entry of its own, or a tab with a choice, opens the first panel. With neither, the popup opens on Browser-wide while the whole browser is on a tunnel.

**The tunnel button says the choice is the tab's only when it is.** "Set for this tab" is drawn only while the tab carries a choice equal to the tunnel the page goes through; a website that has an entry and a tab with no choice is lit for the page and says nothing about the tab.

**Settings lists a website once it has an entry.** A website a tab put in a profile without "Always use for this site" is not listed, as ADR-0101 says of the storage a visit leaves.

## Context

The owner's words: the first panel on an ordinary website set that website's own permanent entry and was labelled "This site", which made a one-time look through Nym into a standing choice with no mention that it outlives the tab. The owner wants the button to set the tab (or the browser), with one extra switch, "Always use for this site", for the standing choice. ADR-0101 gave the tab a choice but left a website with no choice of its own on the old list, so a person had two kinds of list behind one button and no way to tell which they were on.

## Alternatives considered

- **Keep the website's list and add a tab list beside it.** Rejected: two lists behind one button, told apart only by their label, is what the owner objected to.
- **Make "Always" a third panel or a link to Settings.** Rejected: the choice is made in the moment the person sees the page working or not, and a switch under the rows is where they are looking.
- **Let the popup name the website in each command.** Rejected: the popup's page is the one place an old or confused view can send a website other than the tab's; reading it from the tab in main at the moment of the command cannot be wrong that way, and `shownOrigin` is kept only to refuse.
- **Turn Always off by removing the entry only.** Rejected: a tab with no choice would then follow the browser, and the page would change tunnel under the person's hand; the tab takes the tunnel first.

## Reasoning

The tab's choice already beats a website's entry (ADR-0101), so a row that sets the tab changes what the page does at once and is the cheapest thing to undo; a standing entry is the thing that needs a deliberate act. Writing the plan of each change as a table of the tab's choice, the website's entry and whether the browser is on a tunnel (`site-always.ts`) lets one test row show, for every combination, that the tunnel the page leaves by does not change when Always is pressed.

## Consequences

- A person who used the old list to give a website a tunnel for good presses one more switch. The ports that do so should turn Always on; the catalogue rows that stated the old behaviour say so.
- A row on a website now asks the storage question each time the website moves into a profile it has no recorded storage in, since only an entry records that storage; the question is true each time.
- A tab's choice on a website is not listed in Settings, and its storage in the profile is not either, until Always is on or the person clears it with the profile's data.
- **Provisional: the proxy's address change counts only websites with an entry.** Changing the proxy's address asks first, naming the sites and apps that use it; a tab that chose the proxy without Always is not counted. What would settle it is a person who changes the address and finds a tab closed without having been told; the answer is to count the tabs too.
- **Provisional: the first panel names the website under the title for a tab on a website.** The tab alone has no name; a tab on a website is named by it. What would settle it is the owner finding the line redundant with the address bar.

## Reversibility

- **Cost to reverse:** moderate. The command and its refusals are in the main process and the popup; no file format changes (an entry is the one ADR-0089 wrote), so a build that predates it reads the same `routes.json`.
- **What would make us revisit:** a person who wants a row to remember the website without asking, or the provisional notes above settling the other way.
