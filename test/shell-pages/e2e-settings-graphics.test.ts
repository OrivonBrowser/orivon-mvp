// The WebGPU-on-X11 row in Settings, under Performance: shown on an X11 session and on no other platform, it turns the
// setting on and asks to start again, and after Orivon turned it off by itself it says why. The switches themselves
// are proved in test/page/e2e-webgpu-x11.test.ts.
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS } from '../support/qa-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'

afterAll(async () => { expect(await assertNoElectronSurvivors()).toEqual([]) })

const KEY = 'graphics.webgpuOnX11'
const LINUX = process.platform === 'linux'
const LABEL = 'Use the graphics card for WebGPU on X11'
const REVERTED = 'Orivon turned this off because the graphics process crashed while it was on.'

interface Seeded {
  readonly setting?: boolean
  readonly revert?: { readonly at: string, readonly why: string }
}

const seed = ({ setting, revert }: Seeded) => async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
  if (setting !== undefined) await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { [KEY]: setting } }))
  if (revert !== undefined) await writeFile(join(dir, 'x11-vulkan.json'), JSON.stringify({ pendingWindow: false, revert }))
}

async function performancePage (seeded: Seeded): Promise<{ app: ElectronApplication, page: Page, dir: string }> {
  const { app, chrome } = await launchShell({ seedProfile: seed(seeded) })
  try {
    await chrome.evaluate(() => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal('settings', '/performance') })
    expect(await waitFor(() => app.windows().some((w) => w.url().startsWith('orivon://settings')))).toBe(true)
    const page = app.windows().find((w) => w.url().startsWith('orivon://settings')) as Page
    await page.waitForSelector('#row-memory-saver')
    return { app, page, dir: await app.evaluate(({ app: electron }) => electron.getPath('userData')) }
  } catch (error) {
    await closeElectron(app)
    throw error
  }
}

const settingIn = async (dir: string): Promise<unknown> => {
  try { return (JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')) as { values?: Record<string, unknown> }).values?.[KEY] } catch { return undefined }
}

it('shows the row on an X11 session, off, with no restart asked for, and on no other platform', async () => {
  const { app, page } = await performancePage({})
  try {
    expect(await page.locator('#row-webgpu-on-x11').count()).toBe(LINUX ? 1 : 0)
    expect(await page.locator('#row-webgpu-on-x11-restart').count()).toBe(0)
    if (!LINUX) {
      expect(await page.getByText(LABEL).count()).toBe(0)
      expect(await page.locator('h3.group-label', { hasText: 'Graphics' }).count()).toBe(0)
      return
    }
    expect(await page.locator('#row-webgpu-on-x11 .row-label').textContent()).toBe(LABEL)
    expect(await page.locator('#row-webgpu-on-x11 input').isChecked()).toBe(false)
    expect(await page.locator('h3.group-label', { hasText: 'Graphics' }).count()).toBe(1)
    expect(await page.locator('#row-webgpu-on-x11 .row-help').textContent()).not.toContain(REVERTED)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it.skipIf(!LINUX)('turns on, saves the choice, and asks to start again; turning it off again withdraws the ask', async () => {
  const { app, page, dir } = await performancePage({})
  try {
    await page.locator('#row-webgpu-on-x11 .switch').click()
    expect(await waitFor(async () => await page.locator('#row-webgpu-on-x11 input').isChecked())).toBe(true)
    expect(await page.locator('#row-webgpu-on-x11-restart .row-label').textContent()).toBe('Start again to apply')
    expect(await page.locator('#row-webgpu-on-x11-restart .row-help').textContent()).toBe('The choice above is read when Orivon starts. Your tabs and windows are not restored.')
    expect(await page.locator('#row-webgpu-on-x11-restart button').textContent()).toBe('Restart Orivon')
    expect(await waitFor(async () => await settingIn(dir) === true)).toBe(true)
    await page.locator('#row-webgpu-on-x11 .switch').click()
    expect(await waitFor(async () => (await page.locator('#row-webgpu-on-x11-restart').count()) === 0)).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it.skipIf(!LINUX)('says why after Orivon turned the choice off by itself, and the line goes when the choice is turned on again', async () => {
  const { app, page } = await performancePage({ revert: { at: '2026-11-03T08:00:00.000Z', why: 'gpu-crash' } })
  try {
    expect(await page.locator('#row-webgpu-on-x11 .row-help').textContent()).toContain(REVERTED)
    await page.locator('#row-webgpu-on-x11 .switch').click()
    expect(await waitFor(async () => !((await page.locator('#row-webgpu-on-x11 .row-help').textContent()) ?? '').includes(REVERTED))).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
