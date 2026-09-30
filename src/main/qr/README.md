# `src/main/qr/`: the page as a QR code

**What lives here.** The sheet that shows the active page's address as a QR code, to scan with a phone.
`qr-open.ts` decides whether a tab has a page worth sharing (not the new-tab page, not one of the shell's own
pages) and opens the sheet with the tab's address, read in main. `qr-overlay.ts` declares the sheet as an overlay and
answers its two requests, copy the link and save the picture; `qr-download.ts` checks and names the PNG the sheet
sends; `qr-real.ts` wires the clipboard and the Downloads folder in. The page is
[`../../renderer/overlay/qr/`](../../renderer/overlay/qr/).

**Tied to Electron.** `qr-real.ts` imports `electron` values (the clipboard, the Downloads path); every other file
needs nothing of it.

**What it depends on.** [`../overlays/`](../overlays/) (`overlay-types.ts`) and, as types only,
[`../shell/`](../shell/) (`tab-types.ts`, `window-registry.ts`).

**What it must never import.** The renderer, or a value from the rest of the shell: the shell lists this feature
(`shortcuts/run-command.ts`, `shell/menu-layout.ts`, `overlays/overlays.ts`), not the other way round.

**Owner stream.** `shell`.

## Design notes

**The page cannot choose what is encoded or copied.** The address is stored when main shows the sheet and is the only
thing `copy` ever writes; the sheet sends no address, path or file name. A `download` carries only the PNG the sheet
drew, which main checks (signature, 200 KB cap) before writing `qr-<host>.png` under a name it builds itself.

**The encoder runs in the overlay's renderer.** `qrcode-generator` (MIT, pure JavaScript) produces the module matrix;
the sheet draws it with SVG primitives and, for a download, onto a canvas. Main never holds the matrix, so the
process that touches the clipboard and the disk parses nothing the page could shape.
