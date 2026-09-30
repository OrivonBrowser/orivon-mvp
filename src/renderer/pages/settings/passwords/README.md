# `src/renderer/pages/settings/passwords/`: the Passwords section's list and its state

**What lives here.** `passwords-model.ts` holds the decisions (order, search, marks, how many rows show, the words an
import or export is told in), `passwords-part.ts` the state (what main listed, what is typed, which button waits for
its second click, which password is on show) and `passwords-view.ts` the DOM. `passwords.css` is the look.

**Tied to Electron, entirely.** A sandboxed page; it reaches main only through the internal bridge.

**What it depends on.** `../model.ts`, `../settings-parts.ts`, `../state.ts` and [`../../shared/`](../../shared/).

**What it must never import.** `electron`, or a value from [`../../../../main/`](../../../../main/).

**Owner stream.** `shell`.

## Design notes

**State never touches the DOM and the view never calls the bridge.** The view asks the part to do things; the part
asks main and tells the view to draw again.

**The saved list is one element kept across redraws** (the same way the page-list control keeps its node), so the search
text and the keyboard survive a change made elsewhere. A list rebuild hands the keyboard back to the button that had it,
found by `data-focus-key`.

**A password is held only while shown.** It is dropped when hidden, when its login goes, when the window loses focus
and after the time main reports; nothing else on the page holds one, and copying never sends one to the page.
