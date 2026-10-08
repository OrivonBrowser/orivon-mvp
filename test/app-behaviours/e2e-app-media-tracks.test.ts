// What a page can count on from a media element's track lists (catalogue: The page on an app's origin): in an
// app's tab `audioTracks` and `videoTracks` exist on every media element, as Electron apps get them from the
// Blink feature `AudioVideoTracks` in their own window; in an ordinary site's tab Chromium's default
// surface stays, which has neither. A media-player app reads both lists' `length` on `loadedmetadata`.
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-media-tracks.test.ts
import { afterAll, beforeAll, expect, it } from 'vitest'
import { appManifest, grantApp, startAppServer, type AppServer } from './app-behaviour-support.js'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'

const PAGE = '<!doctype html><title>tracks</title><body><audio id="a"></audio><video id="v"></video></body>'
const HTML = 'text/html; charset=utf-8'

let appServer: AppServer
let siteServer: AppServer
beforeAll(async () => {
  appServer = await startAppServer({ '/': { type: HTML, body: PAGE } })
  siteServer = await startAppServer({ '/': { type: HTML, body: PAGE } })
})
afterAll(async () => {
  await appServer.close()
  await siteServer.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

it('[app:media-element-track-lists] an app tab\'s media elements carry audioTracks and videoTracks, and an ordinary site\'s do not', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runPhase('media track lists', async (check) => {
      await grantApp(app, appServer.origin, appManifest('media-tracks', { fs: { quotaBytes: 1024 } }), [{ capability: 'fs', patterns: [] }])
      const probe = (): string => JSON.stringify({
        protoAudio: 'audioTracks' in HTMLMediaElement.prototype,
        protoVideo: 'videoTracks' in HTMLMediaElement.prototype,
        audioLength: (document.getElementById('a') as HTMLMediaElement & { audioTracks?: { length: number } }).audioTracks?.length ?? null,
        videoLength: (document.getElementById('v') as HTMLMediaElement & { videoTracks?: { length: number } }).videoTracks?.length ?? null
      })

      const appView = await visit(app, chrome, `${appServer.origin}/`)
      const inApp = JSON.parse(await appView.evaluate(probe)) as Record<string, unknown>
      check('[app:media-element-track-lists] in an app tab both lists exist on the media element prototype', inApp['protoAudio'] === true && inApp['protoVideo'] === true, JSON.stringify(inApp))
      check('[app:media-element-track-lists] in an app tab an element with no media has empty lists, so a loadedmetadata handler can read their length', inApp['audioLength'] === 0 && inApp['videoLength'] === 0, JSON.stringify(inApp))

      const siteView = await visit(app, chrome, `${siteServer.origin}/`)
      const inSite = JSON.parse(await siteView.evaluate(probe)) as Record<string, unknown>
      check('[app:media-element-track-lists] in an ordinary site\'s tab neither list exists', inSite['protoAudio'] === false && inSite['protoVideo'] === false && inSite['audioLength'] === null && inSite['videoLength'] === null, JSON.stringify(inSite))
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
