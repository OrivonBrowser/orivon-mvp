# `src/main/os/`: what the operating system is told about Orivon: links opened from other programs, the default-browser registration, shortcuts and sharing

**What lives here.** The decisions and the runners of five things. A link another program hands to a running macOS
app (`open-url.ts`). Whether Orivon is the default browser and the call that makes it so (`default-browser.ts`, its
runner, `os-domain.ts` for the Settings page). The share commands, Copy link and Email link (`share.ts`,
`share-commands.ts`, `share-runner.ts`). A site's shortcut: the file's text (`site-shortcut.ts`), where it is
written (`site-shortcut-runner.ts`), and the sheet that asks for it (`shortcut-open.ts`, `shortcut-overlay.ts`,
`shortcut-real.ts`). `menu-state.ts` says when the main menu greys those rows.

**Tied to Electron, in the runners.** `default-browser-runner.ts`, `share-runner.ts` and `shortcut-real.ts` import
`electron`; every other file takes what it needs through a host interface, so a unit test never touches the machine.

**What it depends on.** [`../shell/`](../shell/) (`ShellWindow`, `ShellServices`, `TabState`), [`../overlays/`](../overlays/)
(`OverlayDef`), [`../page-tools/toast.ts`](../page-tools/toast.ts), [`../launch/launch-context.ts`](../launch/launch-context.ts).

**What it must never import.** [`../shell/tabs.ts`](../shell/tabs.ts) or [`../shell/tab-view.ts`](../shell/tab-view.ts).
Nothing a page or a link supplies reaches a command line or a file path unvalidated.

**Owner stream.** `shell`.

## Design notes

**The default browser is registered only from a packaged build.** A run from source would register the Electron binary,
and an AppImage moves, so `defaultBrowserState` answers "unavailable" for both and the runner never calls
`setAsDefaultProtocolClient` there. Nothing calls it at start-up: only the button in Settings does.

**A shortcut file is built from a page's own words, so every byte is cleaned or escaped.** `site-shortcut.ts` removes
control characters from the name (a line break would start a new line of the file, for example an `Exec=`), quotes every
`Exec=` argument, escapes the characters a quoted argument still reads specially, and doubles `%`. The file name is
`orivon-<slug>-<8 hex>.desktop`, built in main from the address; the sheet sends a name and a tick, never a path or an
address. The places it writes come from the host, which a test points at a temporary directory.

**Email link asks first.** The address and the title are a page's words. They are percent-encoded into a `mailto:`
address, and the same question a page that opens a `mailto:` link is asked is put before the mail program starts.

**No shortcut from a private window.** A shortcut is a file left on the computer, which a private window must not do.
