import { exposeOrdinaryTabSurface } from './ordinary-tab.js'

// Loaded by every ORDINARY TAB (src/main/tabs.ts) -- unprivileged. The
// chrome view (tab strip + toolbar) loads preload/shell.ts instead, which
// is privileged and must never be reachable from here.
//
// ./ordinary-tab.ts's own doc says what this exposes, and why an
// extension's own page (a `chrome-extension:` tab) gets none of it --
// shared with preload/newtab.ts's own fallback branch (a dashboard tab the
// user has navigated away from is an ordinary tab too).
exposeOrdinaryTabSurface()
