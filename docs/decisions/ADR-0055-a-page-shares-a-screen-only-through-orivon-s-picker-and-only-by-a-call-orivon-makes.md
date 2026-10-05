# ADR-0055: A page shares a screen only through Orivon's picker, and only by a call Orivon makes

- **Status:** accepted
- **Date:** 2026-10-05
- **Type:** security
- **Decided by:** owner for the scope (websites, registered apps and the Electron shim); AI recommendation accepted by default for the mechanism below

## Decision

A page in a tab, a website or a registered app, shares a screen, a window or a tab only after the person picks
it in a picker Orivon draws in the page's window, each time the page asks. Nothing is remembered as an allow: a
website's setting (`sites.screenShare`, Ask or Block, per site or as the default) and an app's `media.screen`
grant decide only whether the page may show the picker. The rules:

- **Only a call Orivon makes is granted.** The page's `navigator.mediaDevices.getDisplayMedia` is wrapped in the
  page by the tab's preload. The wrapper asks main for the picker; after the person picks, main opens a one-shot
  ticket for that frame and the preload's isolated world makes the real `getDisplayMedia` call itself and hands
  the stream to the page. The permission gate grants a `media` request with no device type to a page only
  against an open ticket, exactly one request per ticket, and refuses every other one: a call that skips the
  wrapper, and the legacy `getUserMedia` with `chromeMediaSource: 'desktop'` or `'tab'`.
- **The display handler answers only inside a ticket.** `setDisplayMediaRequestHandler` is installed on every
  session and gives the source the person picked: a tab as its main frame (with the tab's audio when the person
  ticks it), a window or a screen as a `desktopCapturer` source (with system audio only on Windows, where Electron
  can capture it). If a granted request turns out not to have been a display request, the page's renderer is ended
  at once.
- **The picker.** Tabs of this process (never Orivon's own pages, an extension's page or a sleeping tab), windows
  and screens, with thumbnails, opened on the page's hints (`displaySurface`, `preferCurrentTab`,
  `selfBrowserSurface`, `systemAudio`, `monitorTypeSurfaces`), which the wrapper reads because Electron never passes
  them to main. On Wayland, where a window or a screen can only be listed by the desktop portal, the picker hands
  that choice to the system's own dialog. Share is guarded like every consent question (ADR-0052).
- **While a share runs** the page's tab shows that it is sharing, the shared tab shows that it is shared, a bar in
  the window names the site with Stop sharing, and memory saver keeps the page awake. Stop ends every track the
  preload handed to the page, clones included, and tells the page they ended.
- **A registered app** declares `media.screen` in `Capabilities.media`, beside `media.camera` and
  `media.microphone`, and the three are granted through the grant ledger as ADR-0032 set out for its app door. A
  website never needs a grant: the picker is its consent.
- **The Electron shim's `desktopCapturer.getSources`** shows the same picker and returns the one source the person
  picked; the shim's `getUserMedia` serves that source's stream to the legacy `chromeMediaSource: 'desktop'` call.

## Context

Electron 44 hands a page's `getDisplayMedia` and a legacy `getUserMedia({ chromeMediaSource: 'desktop' })` to the
permission handler as the same request: permission `media`, `mediaTypes: []`, the same origin and frame
(`shell/browser/web_contents_permission_helper.cc` lists only device types). Granting the legacy call captures
whatever source id the page names, the entire screen when it names none, with no picker and no display handler
(measured). Main has no event for a running screen or window capture and no API to end one; only a captured tab
reports `isBeingCaptured()`, and ending the requesting document ends every capture (measured). Electron never
passes the page's `getDisplayMedia` options to main. The display handler runs only when the permission handler has
granted the request first.

## Alternatives considered

- **Grant `media` with no device type to every website and pick in the display handler**, as Electron apps
  commonly do. It gives every page the entire screen through the legacy call, silently.
- **Capture in a hidden Orivon page and give the website a capture of that page.** Airtight at the gate, but every
  screen share is drawn twice, its size and frame rate are those of the hidden page, and the page is told it got a
  tab.
- **Electron's system picker (`useSystemPicker`).** macOS 15 only, offers no tabs, and the display handler (and so
  every rule here) never runs.
- **Remember an allow per site**, like camera and microphone. A share is a choice of what to show each time; Chrome
  does not remember one either.

## Reasoning

The ticket is the only fact main can trust that a request is the display call it expects: Orivon's own code made it,
from the isolated world, in the same step that armed the ticket, so the page can neither make it nor time a legacy
call to take its place without being refused. The wrapper only asks; a page that goes around it is refused, so the
security of the gate never depends on the page leaving the wrapper alone.

## Consequences

- Stop is cooperative for a screen or window share: main cannot end one, so a page that copied a track through a
  realm the preload does not reach keeps it after Stop. Closing or reloading the tab always ends it; on Wayland and
  macOS the system shows its own indicator. A tab share's indicator is exact (`isBeingCaptured`).
- Only the top frame can share. A tab's preload runs in the top frame only (ADR-0052), so an embedded page's call
  meets no wrapper and is refused, `allow="display-capture"` or not.
- `permissions.query({ name: 'display-capture' })` answers `granted` where the page may ask and `denied` where it may
  not, because Electron's check handler cannot answer `prompt`.
- Windows and macOS paths are written to Electron's documentation and are not measured on those systems in this
  repository; Linux X11 and Wayland are.

## Reversibility

- **Cost to reverse:** moderate. The `media.screen` kind is in `src/contracts/` and stays; the gate and the picker
  are Orivon's own code.
- **What would make us revisit:** Electron telling display capture apart from the legacy call in the permission
  request, or giving main a way to end a capture; either would let the gate drop the ticket or make Stop exact.
