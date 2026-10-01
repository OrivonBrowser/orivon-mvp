import type { ChromeContext, ChromeModule, OverlayAnchor } from './context.js'

/** Tells main where the address pill is, so a prompt that belongs under the address bar (a permission, a
 * saved-password offer) can open there from main's side. Reports only when the rectangle changed: the pill
 * moves with the window, with the toolbar's other buttons and with the bookmarks bar. `find` is for tests. */
export function createPromptAnchor (find: () => Element | null = () => document.querySelector('#address-pill')): ChromeModule {
  let last: OverlayAnchor | undefined
  let pill: Element | null = null
  let scheduled = false

  function report (ctx: ChromeContext): void {
    scheduled = false
    if (pill === null) return
    const now = ctx.anchorFor(pill)
    if (now.width === 0 || now.height === 0) return
    if (last !== undefined && last.x === now.x && last.y === now.y && last.width === now.width && last.height === now.height) return
    last = now
    void ctx.shell.act('prompt.anchor', now)
  }

  return {
    name: 'prompt-anchor',
    init: (ctx) => {
      pill = find()
      if (pill === null) return
      const later = (): void => {
        if (scheduled) return
        scheduled = true
        queueMicrotask(() => { report(ctx) })
      }
      globalThis.addEventListener?.('resize', later)
      if (typeof ResizeObserver !== 'undefined') new ResizeObserver(later).observe(pill)
      report(ctx)
    },
    render: (_state, ctx) => { report(ctx) }
  }
}
