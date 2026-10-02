import type { OrivonShell } from '../preload/shell.js'
import { createChromeContext, must } from './chrome/context.js'
import { dispatchShellEvent, initModules, renderModules } from './chrome/modules.js'

// The chrome view's whole job: render ShellState, turn clicks and typing into orivonShell.* commands.
// Main holds truth (src/main/shell/tabs.ts, src/main/browsing/bookmarks.ts) -- nothing here guesses at
// state between pushes. Each feature is a module under chrome/, listed in chrome/modules.ts.
// The chrome never changes its own URL, not even the fragment: main refuses every command from a sender
// at any other URL (ipc.ts's isFromChrome), so a hash change or pushState would silence it.

declare global {
  interface Window {
    orivonShell?: OrivonShell
  }
}

const shell = must(window.orivonShell, 'orivonShell not exposed -- the preload did not run, or location.href did not match --orivon-shell-url')

// See ../style.css's [data-platform] rules -- reserves room for Electron's native window buttons before the
// first paint, rather than waiting on a state push.
document.documentElement.dataset['platform'] = shell.platform

const { ctx, setState } = createChromeContext(shell)
initModules(ctx)

shell.onState((state) => {
  setState(state)
  renderModules(state, ctx)
})

shell.onCommand((event) => { dispatchShellEvent(event, ctx) })
