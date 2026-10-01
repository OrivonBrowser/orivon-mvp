import type { ShellState, TabState } from '../../main/shell/tabs.js'
import type { ChromeContext, TabDecorator } from './context.js'

// One feature's throw must not stop the others: the toolbar, the strip and every module after it share
// one init loop, one render loop per state push and one decorator loop per tab.

/** Runs `run`; a throw is logged with the name of the feature that owns it and swallowed. */
export function contained (what: string, run: () => void): void {
  try {
    run()
  } catch (error) {
    console.error(`[chrome] ${what} failed:`, error)
  }
}

/** Every decorator on one tab's element; a decorator that throws is logged and the ones after it still run. */
export function runDecorators (decorators: readonly TabDecorator[], el: HTMLElement, tab: TabState, state: ShellState, ctx: ChromeContext): void {
  decorators.forEach((decorate, index) => {
    contained(`tab decorator ${decorate.name === '' ? `#${String(index)}` : decorate.name}`, () => { decorate(el, tab, state, ctx) })
  })
}
