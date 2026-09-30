# `src/main/shell/signals/`: what a tab's page reports about itself

**What lives here.** One `TabSignal` per thing a tab's `webContents` tells the shell: `audio.ts` (sound and the
person's mute), `crashed.ts` (a dead or unresponsive page), `find.ts` (the find bar's events and Escape in the
page) and `stop-key.ts` (Escape stops a load). Each is listed in `TAB_SIGNALS` in
[`../tab-signals.ts`](../tab-signals.ts), which calls its `wire`, `apply` and `state` hooks for every tab.

**Tied to Electron, entirely.** Each file listens to a `WebContents`; the decisions they act on live in the
feature's own directory ([`../../find/`](../../find/), [`../../sad-tab/`](../../sad-tab/)).

**What it depends on.** `../tab-signals.ts` and `../tab-types.ts` for the hook and record types, and the feature
directory a signal feeds.

**What it must never import.** [`../tabs.ts`](../tabs.ts): a signal sees one tab through its context, never the
collection.

**Owner stream.** `shell`.

## Design notes

**State a person chose lives on the tab's record, not on a `webContents`.** A cross-origin navigation swaps the
view, so `apply` puts the record's state (the mute) back on whatever view returns. A signal reads `record.host`
when an event fires, because a tab that moves to another window keeps its listeners. One that throws is logged by
name and the rest run.
