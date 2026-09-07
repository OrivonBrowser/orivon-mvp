# `src/main/` — the Electron main process

**What lives here.** The browser shell: the window, tab management, the omnibox, shell IPC, and
the subsystem registry every other stream plugs into.

**What it depends on.** `electron`, [`src/contracts/`](../contracts/).

**What it must never import.** [`src/renderer/`](../renderer/) code. The main process and the
renderer communicate over IPC, never by sharing modules.

**Owner stream.** `shell` — build step 1, **done**. Maintenance only; other streams add
themselves via `subsystems.ts` rather than editing here.

| File | Responsibility |
|---|---|
| `index.ts` | Entry point. Runs the subsystem registry, then creates the window |
| `registry.ts` | `Subsystem`, and the two phase runners. Unit tested, no Electron at runtime |
| `subsystems.ts` | **The append point.** Adding a subsystem is two lines here |
| `window.ts` | Composes the frameless `BaseWindow`: chrome view on top, active tab view below |
| `tabs.ts` | `TabManager` — creating, switching, closing, bounds |
| `ipc.ts` | Shell IPC channels between the chrome view and main |
| `omnibox.ts` | Address-bar input: URL or search. Unit tested |

## Two things not to rediscover

**`webPreferences` is load-bearing.** `contextIsolation: true`, `sandbox: true`,
`nodeIntegration: false` are what keep the preload's port out of the page
([`security-model.md`](../../docs/architecture/security-model.md) T17). A hookify rule rejects
edits that weaken them.

**`BaseWindow`, not `BrowserWindow`.** `BrowserWindow` supports a single full-size web view;
the shell needs a chrome view *plus* tab views, which only `BaseWindow` composes.

**Main and preload are CommonJS; only the renderer is ESM.** A sandboxed preload has no ESM
context at all. `sandbox: true` is non-negotiable, so the preload must be CJS, and matching
main to it avoids a two-format build for no gain. An ESM main process does work — verified
against Electron 44 — if a reason to switch ever appears.

## Design notes

Why the code here has the shape it has. This is the destination
[`code-guidelines.md`](../../docs/development/code-guidelines.md) Rule 1 names for rationale: a
source comment protects a specific line from a specific mistake; the case for a file's overall
shape belongs here instead.

**[`index.ts`](index.ts) — do not re-add `ozone-platform: x11`.** Tried and reverted 2026-08-26,
same session: it was tried on a since-corrected diagnosis (a report of "no window ever appears"
was first misread as the window opening on the wrong monitor, chased partway down a
Wayland-can't-control-window-position path). It made things strictly worse — the GPU process
segfaulted under XWayland on this machine (`exit_code=139`) and the window stopped rendering at
all — and was reverted immediately. The real bug was never about display selection; see
[`window.ts`](window.ts)'s `showOnce` comment for the actual root cause and fix (`ready-to-show`
unreliable when loading from the dev server).

**[`favicon.ts`](favicon.ts) — main fetches favicons to a `data:` URL rather than letting the
renderer fetch directly.** AI recommendation, not yet an owner decision. The chrome view's CSP
(`index.html`) is a one-line, readable guarantee today that the one privileged view in this app
makes zero outbound requests. Letting the renderer `<img src>` an arbitrary, attacker-influenced
`https://` URL directly would need `img-src 'self' https:` and hands a hostile page a live
request from the privileged, cookie-bearing chrome origin — a new, silent tracking surface
exactly where this codebase has been careful before (`mvp-scope.md` already flags DuckDuckGo
search itself as a stated "known limitation" for far less: leaving the machine at all). Fetching
in main instead keeps the guarantee intact; the CSP only needs `img-src 'self' data:`.
