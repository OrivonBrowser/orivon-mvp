import { exposeOrivon } from './orivon-surface.js'

// Loaded by every ORDINARY TAB (src/main/tabs.ts) -- unprivileged. The
// chrome view (tab strip + toolbar) loads preload/shell.ts instead, which
// is privileged and must never be reachable from here.
//
// The real orivon.* surface lives in ./orivon-surface.ts, shared with
// preload/newtab.ts's own fallback branch -- a dashboard tab the user has
// navigated away from is an ordinary tab too, and must expose the SAME
// thing this file does, not a second copy (code-guidelines.md Rule 3).
exposeOrivon()
