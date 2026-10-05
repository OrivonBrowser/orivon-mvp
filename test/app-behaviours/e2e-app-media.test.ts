// An app's camera and microphone (catalogue: Consent and grants): a manifest that declares `media.camera` or
// `media.microphone` is asked at the first `getUserMedia`, in the tab's own panel, and holds the answer; an app
// that does not declare the kind is refused with no question. Fake devices stand in for hardware; the request
// handler is the real one (never `--use-fake-ui-for-media-stream`, which would skip it).
//
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-media.test.ts
import type { Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { appManifest, grantApp, startAppServer, type AppServer } from './app-behaviour-support.js'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { answerQuestion, noNativeDialogs, questionGone, readQuestion, stubNativeDialogs, waitQuestion } from '../support/question-support.js'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'

const FAKE_DEVICES = '--use-fake-device-for-media-stream'
const HTML = 'text/html; charset=utf-8'
const PAGE = '<!doctype html><title>media</title><body>media</body>'

let declared: AppServer
let undeclared: AppServer
beforeAll(async () => {
  declared = await startAppServer({ '/': { type: HTML, body: PAGE } })
  undeclared = await startAppServer({ '/': { type: HTML, body: PAGE } })
})
afterAll(async () => {
  await declared.close()
  await undeclared.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** What the page's own `getUserMedia` call settles to: the kinds of live track it got, or the error's name. */
const request = async (view: Page, constraints: { video?: boolean, audio?: boolean }): Promise<string> =>
  await view.evaluate(async (wanted) => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(wanted)
      const tracks = stream.getTracks().map((track) => `${track.kind}:${track.readyState}`)
      for (const track of stream.getTracks()) track.stop()
      return tracks.join(',')
    } catch (error) {
      return `ERR:${(error as Error).name}`
    }
  }, constraints)

it('[app:app-media-declared-is-asked-once] a declared camera and microphone are asked in the tab\'s panel, kept on Allow, and a No is not asked again on the page', async () => {
  const { app, chrome } = await launchShell({ args: [FAKE_DEVICES] })
  try {
    await runPhase('declared app media', async (check) => {
      await stubNativeDialogs(app)
      const manifest = appManifest('media-declared', { fs: { quotaBytes: 1024 }, media: { camera: true, microphone: true } })
      await grantApp(app, declared.origin, manifest, [{ capability: 'fs', patterns: [] }])
      const view = await visit(app, chrome, `${declared.origin}/`)

      const first = request(view, { video: true })
      const cameraQuestion = await readQuestion(await waitQuestion(app))
      check('[app:app-media-declared-is-asked-once] the first camera request raises a question in the panel that names the camera', /camera/i.test(`${cameraQuestion.title} ${cameraQuestion.message} ${cameraQuestion.detail}`) && cameraQuestion.buttons.includes('Allow') && cameraQuestion.buttons.includes('Deny'), JSON.stringify(cameraQuestion))
      await answerQuestion(app, 'Allow')
      check('[app:app-media-declared-is-asked-once] on Allow the page gets a live video track', await first === 'video:live', await first)

      check('[app:app-media-declared-is-asked-once] the next camera request is answered with no question', await request(view, { video: true }) === 'video:live' && await questionGone(app))

      const second = request(view, { audio: true })
      const microphoneQuestion = await readQuestion(await waitQuestion(app))
      check('[app:app-media-declared-is-asked-once] the microphone is its own question', /microphone/i.test(`${microphoneQuestion.title} ${microphoneQuestion.message} ${microphoneQuestion.detail}`), JSON.stringify(microphoneQuestion))
      await answerQuestion(app, 'Deny')
      check('[app:app-media-declared-is-asked-once] on Deny the page gets NotAllowedError', await second === 'ERR:NotAllowedError', await second)
      check('[app:app-media-declared-is-asked-once] the same page asking again is refused with no second question', await request(view, { audio: true }) === 'ERR:NotAllowedError' && await questionGone(app))
      check('[app:app-media-declared-is-asked-once] a request for both kinds is refused once the microphone was', await request(view, { video: true, audio: true }) === 'ERR:NotAllowedError' && await questionGone(app))
      check('no native message box was opened', (await noNativeDialogs(app)).length === 0)
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 2)

it('[app:app-media-undeclared-is-refused] an app that does not declare the camera or the microphone is refused them with no question', async () => {
  const { app, chrome } = await launchShell({ args: [FAKE_DEVICES] })
  try {
    await runPhase('undeclared app media', async (check) => {
      await stubNativeDialogs(app)
      await grantApp(app, undeclared.origin, appManifest('media-undeclared', { fs: { quotaBytes: 1024 } }), [{ capability: 'fs', patterns: [] }])
      const view = await visit(app, chrome, `${undeclared.origin}/`)
      check('[app:app-media-undeclared-is-refused] a camera request is refused with NotAllowedError', await request(view, { video: true }) === 'ERR:NotAllowedError')
      check('[app:app-media-undeclared-is-refused] a microphone request is refused with NotAllowedError', await request(view, { audio: true }) === 'ERR:NotAllowedError')
      check('[app:app-media-undeclared-is-refused] no question was raised for either', await questionGone(app))
      check('no native message box was opened', (await noNativeDialogs(app)).length === 0)
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 2)
