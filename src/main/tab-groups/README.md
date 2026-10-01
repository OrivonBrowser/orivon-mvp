# `src/main/tab-groups/`: named, coloured tab groups

**What lives here.** Tab groups: a name, a colour and a collapsed flag per group, held per window, with each tab's
group on its record (`TabRecord.groupId`). `groups-model.ts` is the store (`groupsFor(tabs)`, ids unique per process),
`group-order.ts` the pure decisions about where grouped tabs sit, `groups-sync.ts` the check that brings a strip back
to the rules after anything changed it, `groups-runner.ts` the commands (`groupTab`, `ungroupTab`, `closeGroup`,
`toggleCollapsed`, `moveGroup`, `stepTab`), `group-window.ts` sending a group to a window of its own,
`tab-group-overlay.ts` the bubble under a chip, and `restore-groups.ts` making a saved window's groups again.
`groups-hook.ts` wires one window (`window-hooks.ts`) and `install-tab-groups.ts` the process
(`shell/shell-installers.ts`). The chips and the tab lines are drawn by
[`../../renderer/chrome/tab-groups.ts`](../../renderer/chrome/tab-groups.ts), the bubble's page is
[`../../renderer/overlay/tab-group/`](../../renderer/overlay/tab-group/), and the file keeps groups in
`session.json` ([`../session-restore/`](../session-restore/)).

**What it depends on.** [`../shell/`](../shell/) (the tab collection, `setPinned`, `sendChromeEvent`, the window
types and the strip's ordering functions); [`../overlays/`](../overlays/) (`overlay-types.ts`); `electron` through the
tab collection only. `groups-model.ts`, `group-order.ts` and `group-label.ts` import nothing from Electron.

**What it must never import.** The renderer, or a value from [`../shell/tabs.ts`](../shell/tabs.ts): the shell lists
this feature, not the other way round.

**Owner stream.** `shell`.

**Electron dependence.** Tied to Electron through the tab collection and the overlay host; the model and the ordering
decisions take plain values.

## Design notes

**A group is one run of neighbours, and a tab's group follows from where it lands.** The strip keeps no second list:
`groupAfterMove` reads the two neighbours of a moved tab. Between two tabs of a group it joins; at the edge of its own
group it stays; anywhere else it is in none. So the keys, a drag and a tab arriving from another window need no
group-specific code beyond the one hook (`TabManager.afterMove`) that calls it.

**One check keeps the rules true.** `reconcile` runs on every state change and after the hooks: no empty group, no
pinned or half-split tab in a group (the second pane of a pair takes the first pane's group), each group gathered into
one run, and the tab in front never hidden in a collapsed group. Anything that reorders the strip, split view and
pinning included, is covered without knowing groups exist. Its own moves run with the hooks silenced
(`whileWorking`), so they are not taken for a person's.

**Collapsing never hides the tab in front.** `toggleCollapsed` goes to the nearest tab still shown, or opens a new
one, before it hides anything; a later activation of a hidden tab (a search, a key) shows the group again.

**A page opens a tab inside the opener's group.** `TabManager.afterOpen` is called with the tab that was in front;
a popup or a blob tab Chromium made itself is not covered.

**Groups are per window.** A tab that moves to another window leaves its group (`install-tab-groups.ts`), unless it
lands between two tabs of one there.
