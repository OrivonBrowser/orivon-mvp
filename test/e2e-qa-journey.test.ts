// One user journey through the whole chain, and back again after a restart:
// the toolbar star (renderer) -> IPC -> the main process's bookmark store ->
// bookmarks.json on disk -> a relaunch on the same profile -> the bookmarks bar
// and the bookmark's own link -> unstarring -> a second relaunch that must not
// resurrect it. Every other bookmark spec stays inside one launch.

import { readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { removeThroughBubble } from './bookmark-bubble-helpers.js'
import { runPhase } from './e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron, profileDirOf } from './launch-electron.mjs'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit, type FixtureServer } from './qa-helpers.js'
import { ABSENCE_SETTLE_MS, bookmarksBarMatches, bookmarkUrls, delay, waitFor, waitForTab } from './smoke-helpers.mjs'

let server: FixtureServer
beforeAll(async () => {
  server = await startServer((req, res) => { html(res, `<!doctype html><title>Journey ${req.url ?? ''}</title><h1>Journey ${req.url ?? ''}</h1>`) })
})
afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const dashboardOf = (app: ElectronApplication): Page | undefined => app.windows().find((w) => w.url().endsWith('/newtab/index.html'))

it('a bookmark starred through the toolbar is on disk, survives a restart, and unstarring it survives one too', async () => {
  const url = () => `${server.origin}/saved`
  const first = await launchShell()
  const profile = profileDirOf(first.app)
  if (profile === undefined) throw new Error('the launcher did not report a profile directory')
  const onDisk = async (): Promise<string> => await readFile(join(profile, 'bookmarks.json'), 'utf8').catch(() => '')
  let live: ElectronApplication = first.app
  try {
    await runPhase('bookmark journey across restarts', async (check) => {
      await visit(first.app, first.chrome, url())
      await first.chrome.click('#bookmark-toggle')
      check('the star marks the page as bookmarked', (await waitForTab(first.chrome, { bookmarked: true })).ok)
      check('the bookmarks bar shows it', await waitFor(async () => (await bookmarkUrls(first.chrome)).includes(url())))
      check('the main process wrote it to bookmarks.json', await waitFor(async () => (await onDisk()).includes(url())), (await onDisk()).slice(0, 200))
      await closeElectron(first.app, { keepProfile: true })

      const second = await launchShell({ reuseProfile: profile })
      live = second.app
      check('after a restart the bookmarks bar is drawn and sized', await waitFor(() => bookmarksBarMatches(second.chrome, true)))
      const inBar = await waitFor(async () => (await bookmarkUrls(second.chrome)).includes(url()))
      check('after a restart the bookmark is in the bar', inBar, JSON.stringify(await bookmarkUrls(second.chrome)))
      // Clicking what is not there would time out and hide the check that named the cause.
      if (inBar) {
        await second.chrome.click(`#bookmarks-list .bmitem[title="${url()}"]`)
        const opened = await waitForTab(second.chrome, { address: url(), bookmarked: true })
        check('its link opens the page, which shows as bookmarked', opened.ok, JSON.stringify(opened.info))
      } else {
        check('its link opens the page, which shows as bookmarked', false, 'the bookmark was not in the bar to click')
        await visit(second.app, second.chrome, url())
      }

      await removeThroughBubble(second.app, second.chrome)
      check('unstarring marks the page as not bookmarked', (await waitForTab(second.chrome, { bookmarked: false })).ok)
      check('the main process removed it from bookmarks.json', await waitFor(async () => !(await onDisk()).includes(url())), (await onDisk()).slice(0, 200))
      await closeElectron(second.app, { keepProfile: true })

      const third = await launchShell({ reuseProfile: profile })
      live = third.app
      expect(await waitFor(() => dashboardOf(third.app) !== undefined)).toBe(true)
      // A removal is an absence, and an absence cannot be polled for: settle, then read once.
      await delay(ABSENCE_SETTLE_MS)
      check('after a second restart the removed bookmark is not back', !(await bookmarkUrls(third.chrome)).includes(url()), JSON.stringify(await bookmarkUrls(third.chrome)))
      check('and the bar is hidden again, with no space kept for it', await bookmarksBarMatches(third.chrome, false))
    })
  } finally {
    await closeElectron(live)
    await rm(profile, { recursive: true, force: true })
  }
}, QA_TEST_TIMEOUT_MS)
