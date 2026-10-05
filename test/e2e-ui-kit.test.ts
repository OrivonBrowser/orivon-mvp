// The shared UI kit (src/renderer/pages/shared/kit.css and the icons) rendered
// in the real shell: a fixture page lists every component in every state, is
// loaded from the real stylesheets in both colour schemes, and is checked for
// the sizes, colours and states the kit promises. Set ORIVON_UI_SHOTS_DIR to
// also write one screenshot per section and scheme, for a human to look at.
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import type { CDPSession, ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, launchElectron, mainOutput } from './support/launch-electron.mjs'
import { clickAddressBarRetrying } from './support/e2e-helpers.js'
import { findChrome, HERMETIC_RESOLVER, waitFor } from './support/smoke-helpers.mjs'

const FIXTURE_DIR = fileURLToPath(new URL('./fixtures/ui-kit/', import.meta.url))
const SHARED_DIR = fileURLToPath(new URL('../src/renderer/pages/shared/', import.meta.url))
const SHOTS_DIR = process.env.ORIVON_UI_SHOTS_DIR
const TEST_TIMEOUT_MS = 90_000
const SECTIONS = ['buttons', 'forms', 'feedback', 'banners', 'lists', 'sheet', 'icons'] as const
const SHARED_FILES = new Set(['tokens.css', 'controls.css', 'kit.css'])

let server: Server
let origin = ''
let pageScript = ''

beforeAll(async () => {
  const bundle = await build({ entryPoints: [join(FIXTURE_DIR, 'page.ts')], bundle: true, format: 'esm', write: false, logLevel: 'silent' })
  pageScript = bundle.outputFiles[0]?.text ?? ''
  server = createServer((request, response) => {
    const url = request.url ?? '/'
    const send = (type: string, body: string): void => { response.setHeader('content-type', type); response.end(body) }
    if (url === '/') send('text/html', readFileSync(join(FIXTURE_DIR, 'index.html'), 'utf8'))
    else if (url === '/fixture.css') send('text/css', readFileSync(join(FIXTURE_DIR, 'fixture.css'), 'utf8'))
    else if (url === '/page.js') send('text/javascript', pageScript)
    else if (url.startsWith('/shared/') && SHARED_FILES.has(url.slice('/shared/'.length))) send('text/css', readFileSync(join(SHARED_DIR, url.slice('/shared/'.length)), 'utf8'))
    else { response.statusCode = 404; response.end() }
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`
  // The kit's stylesheet imports resolve under /shared/ next to tokens and controls.
  expect(readFileSync(join(SHARED_DIR, 'controls.css'), 'utf8').split('\n')[0]).toBe("@import './kit.css';")
})

afterAll(async () => {
  await new Promise<void>((resolve) => { server.close(() => { resolve() }) })
  expect(await assertNoElectronSurvivors()).toEqual([])
})

/** Holds each `[data-force]` element in the pseudo-classes its attribute names, so a state the mouse
 * cannot hold still while a screenshot is taken (hover, keyboard focus, pressed) is drawn for real. */
async function forceStates (page: Page): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page)
  await cdp.send('DOM.enable')
  await cdp.send('CSS.enable')
  const { root } = await cdp.send('DOM.getDocument', { depth: -1 })
  const { nodeIds } = await cdp.send('DOM.querySelectorAll', { nodeId: root.nodeId, selector: '[data-force]' })
  for (const nodeId of nodeIds) {
    const { attributes } = await cdp.send('DOM.getAttributes', { nodeId })
    const forced = attributes[attributes.indexOf('data-force') + 1] ?? ''
    await cdp.send('CSS.forcePseudoState', { nodeId, forcedPseudoClasses: forced.split(' ') })
  }
  return cdp
}

async function openFixture (app: ElectronApplication): Promise<Page> {
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  await clickAddressBarRetrying(findChrome(app), `${origin}/`)
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith(origin)))).toBe(true)
  const page = app.windows().find((w) => w.url().startsWith(origin)) as Page
  await page.waitForSelector('html[data-ready="true"]', { state: 'attached' })
  return page
}

/** Computed values of one element, read in the page so a check names what a person would see. */
async function style (page: Page, selector: string, props: string[]): Promise<Record<string, string>> {
  return await page.evaluate(([sel, names]) => {
    const el = document.querySelector(sel as string)
    if (el === null) throw new Error(`no element matches ${sel as string}`)
    const computed = getComputedStyle(el)
    return Object.fromEntries((names as string[]).map((name) => [name, computed.getPropertyValue(name)]))
  }, [selector, props])
}

async function box (page: Page, selector: string): Promise<{ width: number, height: number }> {
  const found = await page.locator(selector).first().boundingBox()
  if (found === null) throw new Error(`${selector} has no box`)
  return { width: Math.round(found.width * 10) / 10, height: Math.round(found.height * 10) / 10 }
}

it('draws every component at its promised size and state, in light and dark', async () => {
  const app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
  try {
    const page = await openFixture(app)
    await forceStates(page)
    if (SHOTS_DIR !== undefined) mkdirSync(SHOTS_DIR, { recursive: true })

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'no-preference' })
      expect((await style(page, '.spinner', ['animation-name']))['animation-name']).toBe('kit-spin')
      expect((await style(page, '.progress.indeterminate .progress-bar', ['animation-name']))['animation-name']).toBe('progress-slide')
      await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' })

      // Buttons: sizes, then the state each row of the matrix is forced into.
      expect(await box(page, '.btn.icon')).toEqual({ width: 28, height: 28 })
      expect((await style(page, '.btn.icon svg', ['width', 'height']))).toEqual({ width: '16px', height: '16px' })
      expect((await style(page, '.btn.small', ['font-size', 'padding']))).toEqual({ 'font-size': '12.5px', padding: '3px 10px' })
      expect((await style(page, '.btn.primary[data-force="hover"]', ['filter'])).filter).toBe('brightness(1.08)')
      expect((await style(page, '.btn.primary[data-force="hover active"]', ['filter'])).filter).toBe('brightness(0.96)')
      expect((await style(page, '.btn.primary[disabled]', ['opacity'])).opacity).toBe('0.5')
      expect((await style(page, '.btn[data-force="focus focus-visible"]', ['outline-style', 'outline-width']))).toEqual({ 'outline-style': 'solid', 'outline-width': '2px' })
      expect((await style(page, '.btn.danger.armed[data-force="hover active"]', ['filter'])).filter).toBe('brightness(0.96)')
      expect((await style(page, '.link-btn', ['color', 'cursor'])).cursor).toBe('pointer')
      expect((await style(page, '.btn.icon[aria-pressed="true"]', ['background-color']))['background-color']).not.toBe('rgba(0, 0, 0, 0)')

      // A profile's avatar is `.chip.mark`: the kit's pill must leave it alone.
      const avatar = await page.evaluate(() => {
        const el = document.createElement('span')
        el.className = 'chip mark'
        document.body.append(el)
        const computed = getComputedStyle(el)
        const result = { border: computed.borderTopWidth, cursor: computed.cursor, padding: computed.paddingLeft }
        el.remove()
        return result
      })
      expect(avatar).toEqual({ border: '0px', cursor: 'auto', padding: '0px' })

      // Progress, badges, banners, toast.
      expect((await box(page, '.progress')).height).toBe(4)
      const track = await box(page, '.progress[aria-valuenow="40"]')
      const bar = await box(page, '.progress[aria-valuenow="40"] .progress-bar')
      expect(Math.abs(bar.width - track.width * 0.4)).toBeLessThan(1)
      expect((await style(page, '.progress.is-error .progress-bar', ['background-color']))['background-color']).not.toBe((await style(page, '.progress[aria-valuenow="40"] .progress-bar', ['background-color']))['background-color'])
      expect((await style(page, '.spinner', ['animation-name']))['animation-name']).toBe('none')
      expect((await box(page, '.progress.indeterminate .progress-bar')).width).toBe((await box(page, '.progress.indeterminate')).width)
      const badgeTones = await page.evaluate(() => ['', 'ok', 'warn', 'danger'].map((tone) => getComputedStyle(document.querySelector(tone === '' ? '.badge:not(.ok):not(.warn):not(.danger)' : `.badge.${tone}`) as Element).backgroundColor))
      expect(new Set(badgeTones).size).toBe(4)
      const bannerBorders = await page.evaluate(() => ['info', 'ok', 'warn', 'error'].map((tone) => getComputedStyle(document.querySelector(`.banner.${tone}`) as Element).borderTopColor))
      expect(new Set(bannerBorders).size).toBe(4)
      expect((await style(page, '.banner:not(.info):not(.ok):not(.warn):not(.error)', ['border-top-color']))['border-top-color']).toBe(bannerBorders[2])
      expect((await style(page, '.toast', ['background-color', 'color']))).toEqual({ 'background-color': 'rgba(32, 33, 36, 0.92)', color: 'rgb(255, 255, 255)' })
      expect(await page.evaluate(() => {
        const el = document.createElement('div')
        el.className = 'banner error'
        el.hidden = true
        document.body.append(el)
        const shown = getComputedStyle(el).display
        el.remove()
        return shown
      })).toBe('none')

      // Lists: the selected row is tinted, a leaf's toggle keeps its width, a level indents 16px.
      expect((await style(page, '.listbox-item[aria-selected="true"]', ['background-color']))['background-color']).not.toBe((await style(page, '.listbox-item[aria-selected="false"]:not([data-force])', ['background-color']))['background-color'])
      expect(await page.evaluate(() => {
        const indents = [...document.querySelectorAll<HTMLElement>('.tree-item')].map((el) => Math.round(el.querySelector('.tree-toggle')?.getBoundingClientRect().left ?? -1) - Math.round(el.getBoundingClientRect().left))
        return indents.slice(0, 3)
      })).toEqual([8, 24, 40])
      expect((await style(page, '.tree-item:not([aria-expanded]) .tree-toggle', ['visibility'])).visibility).toBe('hidden')
      expect((await style(page, '.tab-btn[aria-selected="true"]', ['border-bottom-color', 'color']))['border-bottom-color']).toBe((await style(page, '.tab-btn[aria-selected="true"]', ['color'])).color)
      expect((await style(page, '.check input:checked', ['background-color']))['background-color']).toBe('rgb(79, 70, 229)')

      // Every icon the kit adds has a 24px viewBox and draws something.
      const icons = await page.evaluate(() => [...document.querySelectorAll('#icon-grid svg')].map((el) => ({ box: el.getAttribute('viewBox'), drawn: el.getBoundingClientRect().width > 0 && el.children.length > 0 })))
      expect(icons).toHaveLength(33)
      expect(icons.every((one) => one.box === '0 0 24 24' && one.drawn)).toBe(true)

      if (SHOTS_DIR !== undefined) {
        // Motion is off for the state screenshots, so a spinner or a slide never blurs one.
        for (const id of SECTIONS) writeFileSync(join(SHOTS_DIR, `kit-${id}-${scheme}.png`), await page.locator(`#${id}`).screenshot({ timeout: 30_000 }))
      }
    }
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, TEST_TIMEOUT_MS)
