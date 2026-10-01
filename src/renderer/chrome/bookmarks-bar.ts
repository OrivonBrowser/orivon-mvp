import { createBookmarksView } from '../bookmarks-view.js'
import type { BookmarksView } from '../bookmarks-view.js'
import type { ChromeModule } from './context.js'
import { must } from './context.js'

/** The bookmarks row under the toolbar. */
export function createBookmarksBar (): ChromeModule {
  let view: BookmarksView | undefined
  return {
    name: 'bookmarks-bar',
    init: ({ shell }) => {
      const list = must(document.querySelector<HTMLDivElement>('#bookmarks-list'), '#bookmarks-list missing')
      view = createBookmarksView(
        list,
        (url) => { shell.openBookmark(url) },
        (url) => { shell.removeBookmark(url) }
      )
    },
    render: (state) => {
      // Drives style.css's height override and bookmarks.css's hide rule. main sizes this whole view from
      // the same fact (window.ts's chromeHeight), so the row and the space reserved for it appear and
      // disappear together.
      document.documentElement.dataset['bookmarks'] = state.bookmarksBar ? 'some' : 'none'
      view?.render(state.bookmarks)
    }
  }
}
