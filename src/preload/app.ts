import { exposeOrdinaryTabSurface } from './ordinary-tab.js'
import { inMainFrame } from './frame.js'
import { installPageDialogs } from './page-dialogs.js'

// Loaded by every ORDINARY TAB (src/main/tabs.ts) -- unprivileged. The
// chrome view (tab strip + toolbar) loads preload/shell.ts instead, which
// is privileged and must never be reachable from here.
//
// ./ordinary-tab.ts's own doc says what this exposes, and why an
// extension's own page (a `chrome-extension:` tab) gets none of it --
// shared with preload/newtab.ts's own fallback branch (a dashboard tab the
// user has navigated away from is an ordinary tab too).
// A tab's preload reaches the top frame only: no tab setting runs one in a
// subframe. The inMainFrame() gate (./frame.ts) stays as a second line, so a
// preload that ever did reach a subframe would expose nothing there.
installPageDialogs()
if (inMainFrame()) exposeOrdinaryTabSurface()
