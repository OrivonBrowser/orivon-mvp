# `src/renderer/overlay/`: the one page every overlay shows

**What lives here.** The renderer side of [`../../main/overlays/`](../../main/overlays/): one HTML entry
(`index.html`, `main.ts`) that every overlay view loads, told which overlay it is by its address, and one
folder per overlay with that overlay's page (`auth-sheet/`, `cert-error/`, `certificate/`, `chooser/`, `find/`, `menu/`, `restore/`, `sad-tab/`, `screenshot/`,
`tab-search/`, `toast/`). `pages.ts` maps an overlay's name to its page, one line each, in name order.
`kit.ts` is what a page is written against: `mount(root, overlay)`, the bridge's calls, and the parts that report
the page's height and close it on Escape. `surface.css` and `style.css` paint the shared surface.

**Tied to Electron, entirely.** A sandboxed renderer document; it reaches main only through the bridge that
[`../../preload/overlay.ts`](../../preload/overlay.ts) exposes as `window.orivonOverlay`.

**What it depends on.** `kit.ts` and the DOM helpers and icons of [`../pages/shared/`](../pages/shared/). A page may
import types, never values, from its own feature's `src/main/<feature>/` directory.

**What it must never import.** `electron`, `node:*`, or a value from [`../../main/`](../../main/); another
overlay's folder; the chrome's modules.

**Owner stream.** `shell`.

## Design notes

**A page is text and a handler's replies, nothing more.** Whatever a page shows that a web page controls (a tab's
title, an address, a selection) is set as text, never as markup, and every request a page sends is validated again
by the handler in main. The bridge has four calls and no authority of its own.

**Each page's rules sit under `body[data-overlay='<name>']`,** so all the pages share one stylesheet and cannot
restyle each other. A page imports its own stylesheet; it is bundled into the one overlay entry.
