import { exposeOrivon } from './orivon-surface.js'
import { exposeFetchRoute } from './fetch-route.js'

// Loaded by every ORDINARY TAB (src/main/tabs.ts) -- unprivileged. The
// chrome view (tab strip + toolbar) loads preload/shell.ts instead, which
// is privileged and must never be reachable from here.
//
// The real orivon.* surface lives in ./orivon-surface.ts, shared with
// preload/newtab.ts's own fallback branch -- a dashboard tab the user has
// navigated away from is an ordinary tab too, and must expose the SAME
// thing this file does, not a second copy (code-guidelines.md Rule 3).
exposeOrivon()
// ADR-0017: routes this tab's own fetch() through orivon.net for a
// registered app's granted hosts. Must run AFTER exposeOrivon() -- it
// depends on window.orivon already existing in the main world.
exposeFetchRoute()
