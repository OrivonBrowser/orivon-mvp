// The bookmarks journey, lifted out of smoke.mjs (Rule 2: that file passed
// the 800-line test-file limit). One feature area, start to finish: star a
// page from the toolbar, see it on the bar, open it, remove it from the bar,
// and round-trip it through the dashboard's own IPC.
//
// It takes a context rather than reaching into smoke.mjs, because smoke.mjs
// builds these inside main(): the shared reporter (`check`/`checkTab`), the
// fixture URLs, and the already-parked expectations. Everything that is a
// plain helper is imported here directly instead of being threaded through.
import {
  bookmarkUrls,
  bookmarksBarMatches,
  evaluateRetrying,
  tabViews,
  waitFor,
  waitForTab
} from '../test/smoke-helpers.mjs'

/**
 * @param {{
 *   app: import('playwright-core').ElectronApplication,
 *   chrome: import('playwright-core').Page,
 *   check: (name: string, cond: unknown, detail?: unknown) => void,
 *   checkTab: (name: string, expected: object, result: { ok: boolean, info: unknown }) => void,
 *   clickChecked: (page: unknown, selector: string, name: string) => Promise<boolean>,
 *   navigateTo: (input: string, expected: object) => Promise<{ ok: boolean, info: unknown }>,
 *   urlFor: (path: string) => string,
 *   wantA: object
 * }} ctx
 */
export async function runBookmarksJourney (ctx) {
  const { app, chrome, check, checkTab, clickChecked, navigateTo, urlFor, wantA } = ctx

  // ---- Bookmarks bar: star, appear, open, unstar ------------------------
  // Owner override, 2026-08-28 (mvp-scope.md, ADR-0003) -- not in the
  // original scope pass. Exercises the real path -- click -> IPC ->
  // BookmarkStore -> pushed ShellState -> bookmarks-view.ts -- the same
  // shape every other check in this file already holds tab commands to,
  // rather than calling window.orivonShell.addBookmark() directly.
  const parkedForBookmark = await navigateTo(urlFor('/a'), wantA)
  checkTab('the tab is parked on fixture A before starring it', wantA, parkedForBookmark)

  await clickChecked(chrome, '#bookmark-toggle', 'the bookmark toggle is clickable')
  checkTab(
    'starring the page marks the toggle as bookmarked',
    { bookmarked: true },
    await waitForTab(chrome, { bookmarked: true })
  )

  check(
    'the starred page appears in the bookmarks bar',
    await waitFor(async () => (await bookmarkUrls(chrome)).includes(urlFor('/a')))
  )

  check(
    'a bookmark brings the bar back, in the DOM and in the chrome main sized',
    await waitFor(() => bookmarksBarMatches(chrome, true))
  )

  // Navigate away, then open the bookmark from the bar -- proves its click
  // handler drives a real navigation (openBookmark), not just a render of
  // the stored title.
  const wantB2 = { address: urlFor('/b'), title: 'fixture-b' }
  checkTab('navigated away before opening the bookmark', wantB2, await navigateTo(urlFor('/b'), wantB2))

  const bookmarkClicked = await clickChecked(
    chrome,
    `#bookmarks-list .bmitem[title="${urlFor('/a')}"]`,
    'the bookmarked item is clickable'
  )
  checkTab(
    'clicking the bookmark navigates the active tab to it',
    wantA,
    bookmarkClicked ? await waitForTab(chrome, wantA) : { ok: false, info: undefined }
  )

  await clickChecked(chrome, '#bookmark-toggle', 'the bookmark toggle is clickable to unstar')
  checkTab(
    'unstarring the page clears the toggle',
    { bookmarked: false },
    await waitForTab(chrome, { bookmarked: false })
  )

  check(
    'unstarring removes the page from the bookmarks bar',
    await waitFor(async () => !(await bookmarkUrls(chrome)).includes(urlFor('/a')))
  )

  // ...and the bar goes with it. An empty bar left behind is the exact
  // state this behaviour exists to prevent.
  check(
    'losing the last bookmark takes the bar and the row main sized for it',
    await waitFor(() => bookmarksBarMatches(chrome, false))
  )

  // ---- Bookmarks bar: remove directly from the bar, not just the toolbar
  // Chrome bugfix round, 2026-08-28: the toolbar toggle was the only way
  // to unstar a page (only reachable by returning to that exact page).
  // bookmarks-view.ts now renders a remove button per item -- covers the
  // path the star/open/unstar scenario above never touched.
  await clickChecked(chrome, '#bookmark-toggle', 'the bookmark toggle is clickable to re-star for the removal check')
  check(
    'the page is starred again, ready for the bar-side removal check',
    await waitFor(async () => (await bookmarkUrls(chrome)).includes(urlFor('/a')))
  )

  // ---- The dashboard's own bookmark round-trip --------------------------
  // Proves the FULL IPC path this file's dashboard scenario above never
  // touched (getBookmarks over NEWTAB_COMMAND_CHANNEL), not just that the
  // toolbar's own bookmark bar shows it -- a fresh tab is a SEPARATE
  // WebContentsView with its own preload load, not a rendering of the
  // chrome's already-fetched list.
  const newTabOpened = await clickChecked(chrome, '#new-tab', 'the new-tab button is clickable for the dashboard bookmark check')
  const freshDashboard = newTabOpened && await waitFor(async () => {
    const views = tabViews(app, chrome)
    return views.some((v) => v.url().endsWith('/newtab/index.html'))
  })
  check('a fresh new tab opens showing the dashboard again', freshDashboard)

  if (freshDashboard) {
    const [freshView] = tabViews(app, chrome).filter((v) => v.url().endsWith('/newtab/index.html'))
    // The bookmark's stored title is 'fixture-a' (the real page title
    // captured when it was starred, per bookmarkToggle's addBookmark
    // call in src/renderer/main.ts) -- not the URL, since the title
    // was non-empty at the time.
    const tileLabels = await waitFor(async () =>
      (await evaluateRetrying(freshView, () =>
        Array.from(document.querySelectorAll('#bookmarks-grid .tile-label')).map((el) => el.textContent)
      )).includes('fixture-a')
    )
    check(
      "the starred bookmark appears as a real tile on a FRESH dashboard tab's own IPC round-trip",
      tileLabels
    )

    await clickChecked(freshView, '#bookmarks-grid .tile', 'a bookmark tile on the fresh dashboard is clickable')
    const freshTileNavigated = await waitFor(async () => {
      const info = await evaluateRetrying(chrome, () => ({ address: document.querySelector('#address')?.value }))
      return info.address === urlFor('/a')
    })
    check('clicking the dashboard bookmark tile navigates that tab to it', freshTileNavigated)
    // The extra tab this scenario opened is left open deliberately --
    // the close-everything check at the end of this file (A16) closes
    // whatever tabs exist at that point, however many there are.
  }

  const removeClicked = await clickChecked(
    chrome,
    `#bookmarks-list .bmitem[title="${urlFor('/a')}"] .remove`,
    "the bookmarked item's remove button is clickable"
  )
  check(
    'clicking the remove button removes it from the bar without visiting the page',
    removeClicked && await waitFor(async () => !(await bookmarkUrls(chrome)).includes(urlFor('/a')))
  )
}
