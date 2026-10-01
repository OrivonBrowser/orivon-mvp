# `src/main/memory-saver/`: putting idle tabs to sleep

**What lives here.** Sleeping tabs: when a tab sleeps, how it wakes and the rules that keep one awake.

| File | Job |
|---|---|
| `sleep-rules.ts` | Pure: `canSleep` over the facts, `hostKept`, `delayFor` (memory saver, wait, energy saver), `dueToSleep` |
| `sleep-facts.ts` | Gathers the facts from a live tab; `SleepEnv` is what a test stands in |
| `unsaved-input.ts` | The one question asked of the page, in an isolated world with a timeout |
| `media-in-use.ts` | Which pages use a camera, microphone, screen share or chosen device; the permission code marks them |
| `sleep-tab.ts` | `sleepTab`, `sleepTabWhy`, `wakeTab`, `putToSleep`: the view swap |
| `sleep-signal.ts` | The tab signal that reads a sleeping tab's state from its record |
| `sleep-command.ts` | `tab.sleep` and the tab menu's item: the hop to a neighbour and the refusal toasts |
| `restore-asleep.ts` | `restoreAsleep`: a tab restored from the last session starts asleep |
| `idle-sweep.ts` | The once-a-minute pass and the stamp of when a tab was last in front |
| `start-memory-saver.ts` | Wake on activation, the timer, the setting listener |
| `install-memory-saver.ts` | The installer [`../shell/shell-installers.ts`](../shell/shell-installers.ts) runs: the power source, the test seam |

**What it depends on.** `electron` (`install-memory-saver.ts` and the view swap), [`../shell/`](../shell/) (the tab collection, the view
constructor and wiring, the signal registry), [`../overlays/tab-slots.ts`](../overlays/tab-slots.ts) (`hasAsk`),
[`../page-tools/toast.ts`](../page-tools/toast.ts) and [`../session-restore/`](../session-restore/) (a restored title and the snapshot type).

**What it must never import.** The renderer, or a value from [`../shell/tabs.ts`](../shell/tabs.ts): the shell lists this
feature, not the other way round.

**Owner stream.** `shell`.

**Electron dependence.** Tied to Electron. The rules, the sweep and the wiring are pure and tested with fakes.

## Design notes

**A sleeping tab keeps a blank view, not no view.** Every other part of the shell reads `record.view`, so a tab with no view would
need a case in each. The blank view loads nothing; the record's `sleeping` field holds the address, title, icon and history that the
chrome, the session file and the extensions read instead, through the sleep signal and `snapshotOf`.

**`pageState` never leaves the record.** A history entry's page state carries scroll and form values. It is held in memory on the tab,
handed back to Chromium on waking, and never parsed, logged or written to a file: `snapshotOf` copies only address and title.

**Every caller goes through `sleepTabWhy`.** The command, the idle sweep and an extension's discard all hit one set of rules, and the
rules are checked again after the page's answer about unsaved input, because that round trip is the one place the tab can change.

**Unsaved input is the guard, not `beforeunload`.** A page's listeners are not visible from an isolated world, and the view that
closes is already swapped out, where the shell answers any leave prompt without asking. A page that keeps unsaved work somewhere other
than a text field, text area or editable region is not seen.

**A pending ask keeps a tab awake.** Sleeping would close the page a permission prompt, sign-in or chooser is about, and drop the
person's pending decision.

**Apps and other sessions never sleep.** A registered app's tab holds grants and sockets, and a tab in another session holds that
session's state; both are cut by closing the page.

**The energy saver stands on its own.** On battery it asks for sleep after five minutes whether or not the memory saver is on, and it
never lengthens a wait. The power source is read at each pass, because the OS events exist on some platforms only.
