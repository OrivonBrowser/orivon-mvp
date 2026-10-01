import type { ChromeContext, ChromeModule } from './context.js'
import { hasSite, must } from './context.js'

/** The star opens the bookmark bubble under itself. A page that is not saved is saved first, by main, which reads
 * the address and title from its own tab record; this only says where the star is, and answers the Mod+D event
 * with the same rectangle. */
export function createBookmarkStar (): ChromeModule {
  let star: HTMLButtonElement | undefined

  function openBubble (ctx: ChromeContext, extra: { add: true, toggle: true } | Record<string, never>): void {
    if (star === undefined) return
    void ctx.shell.act('bookmarks.edit', { anchor: ctx.anchorFor(star), ...extra })
  }

  return {
    name: 'bookmark-star',
    init: (ctx) => {
      star = must(document.querySelector<HTMLButtonElement>('#bookmark-toggle'), '#bookmark-toggle missing')
      star.addEventListener('click', () => { if (hasSite(ctx.activeTab())) openBubble(ctx, { add: true, toggle: true }) })
    },
    render: (state) => {
      if (star === undefined) return
      const label = state.bookmarked ? 'Edit bookmark' : 'Bookmark this page'
      star.title = label
      star.setAttribute('aria-label', label)
    },
    event: (payload, ctx) => {
      if (typeof payload === 'object' && payload !== null && (payload as { open?: unknown }).open === true) openBubble(ctx, {})
    }
  }
}
