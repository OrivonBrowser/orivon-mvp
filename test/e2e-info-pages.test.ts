// About Orivon and the task manager in the running shell: the version table and the graphics report, the
// names other browsers use typed into the address bar, the process list with sort, End process and switching
// to a tab, and the JavaScript console key. Set ORIVON_UI_SHOTS_DIR to also write screenshots in both themes.
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron, mainOutput } from './support/launch-electron.mjs'
import { pressKey } from './support/e2e-helpers.js'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visit } from './support/qa-helpers.js'
import type { FixtureServer } from './support/qa-helpers.js'
import { activeTabInfo, delay, tabIds, waitFor, waitForTab } from './support/smoke-helpers.mjs'

const SHOTS_DIR = process.env['ORIVON_UI_SHOTS_DIR']

let server: FixtureServer

beforeAll(async () => {
  server = await startServer((request, response) => {
    const path = request.url ?? '/'
    html(response, `<!doctype html><title>Page ${path}</title><body style="font:16px sans-serif"><h1>${path}</h1></body>`)
  })
})

afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

type App = ElectronApplication
const here = (path = '/'): string => `${server.origin}${path}`

async function runCommand (chrome: Page, id: string): Promise<void> {
  await chrome.evaluate((command) => { (window as unknown as { orivonShell: { runCommand: (id: string) => void } }).orivonShell.runCommand(command) }, id)
}

async function pageAt (app: App, prefix: string): Promise<Page> {
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith(prefix) && !w.isClosed())), `${prefix} did not open`).toBe(true)
  return app.windows().find((w) => w.url().startsWith(prefix) && !w.isClosed()) as Page
}

/** Waits for the address bar to read `address`, with or without the trailing slash an internal page's root may carry. */
async function addressReads (chrome: Page, address: string): Promise<{ ok: boolean, seen: string | undefined }> {
  let seen: string | undefined
  const ok = await waitFor(async () => {
    seen = (await activeTabInfo(chrome) as { address?: string }).address
    return seen?.replace(/\/$/, '') === address
  })
  return { ok, seen }
}

async function shoot (page: Page, name: string): Promise<void> {
  if (SHOTS_DIR === undefined) return
  mkdirSync(SHOTS_DIR, { recursive: true })
  for (const scheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme: scheme })
    await page.evaluate(() => { window.scrollTo(0, 0) })
    await delay(400)
    await page.screenshot({ path: join(SHOTS_DIR, `${name}-${scheme}.png`) })
  }
  await page.emulateMedia({ colorScheme: null })
}

const rowsOf = async (page: Page): Promise<Record<string, string>> => await page.evaluate(() =>
  Object.fromEntries(Array.from(document.querySelectorAll('.card .row')).map((row) => [
    row.querySelector('.row-label')?.textContent ?? '', row.querySelector('.value')?.textContent ?? ''
  ])))

it('shows the version table and the graphics report, with Copy details, at real addresses', async () => {
  const { app, chrome } = await launchShell()
  try {
    await runCommand(chrome, 'about.open')
    const about = await pageAt(app, 'orivon://about')
    await about.waitForSelector('.card .row .value')

    const facts = await app.evaluate(({ app: electronApp }) => ({ orivon: electronApp.getVersion(), electron: process.versions.electron, chromium: process.versions.chrome }))
    expect(await waitFor(async () => (await rowsOf(about))['Chromium'] === facts.chromium)).toBe(true)
    const rows = await rowsOf(about)
    expect(rows['Electron']).toBe(facts.electron)
    expect(rows['Orivon']).toBe(facts.orivon)
    expect(Object.keys(rows)).toEqual([
      'Orivon', 'Electron', 'Chromium', 'Node.js', 'V8', 'Operating system', 'Language',
      'User agent', 'Command line', 'Program location', 'Profile folder', 'Downloads folder'
    ])
    expect(rows['User agent']).toContain(`Chrome/${facts.chromium.split('.')[0] ?? ''}`)
    expect(await about.locator('h1').textContent()).toBe('Orivon')
    expect(await about.locator('.version').textContent()).toBe(`Version ${facts.orivon}`)
    await shoot(about, 'version')

    const copy = about.locator('.head .link-btn')
    await copy.click()
    expect(await waitFor(async () => await copy.textContent() === 'Copied')).toBe(true)
    expect(await waitFor(async () => await copy.textContent() === 'Copy details', 4_000)).toBe(true)

    await about.getByRole('tab', { name: 'Graphics' }).click()
    expect(await addressReads(chrome, 'orivon://about/gpu')).toEqual({ ok: true, seen: expect.any(String) })
    // Either the status card or, on a machine that reports nothing, the banner with its retry.
    expect(await waitFor(async () => await about.locator('.badge, .banner.error').count() > 0)).toBe(true)
    if (await about.locator('.badge').count() > 0) {
      expect(await about.locator('.group-label').allTextContents()).toEqual(['Feature status', 'Graphics device'])
      expect(await about.locator('.badge').first().textContent()).toMatch(/Hardware accelerated|Software only|Disabled|\S/)
      await about.locator('details.raw summary').click()
      expect((await about.locator('.raw-body').textContent() ?? '').length).toBeGreaterThan(20)
    } else {
      expect(await about.locator('.banner.error').textContent()).toContain('Graphics information is not available.')
    }
    await shoot(about, 'graphics')

    await about.getByRole('tab', { name: 'Version' }).click()
    expect(await waitFor(async () => about.url().replace(/\/$/, '') === 'orivon://about')).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('says a private window\'s profile is temporary', async () => {
  const { app, chrome } = await launchShell({ args: ['--orivon-private'] })
  try {
    await runCommand(chrome, 'about.open')
    const about = await pageAt(app, 'orivon://about')
    await about.waitForSelector('.card .row .value')
    expect(await waitFor(async () => (await rowsOf(about))['Profile folder'] === 'Private window (temporary, deleted when it closes)')).toBe(true)
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('opens Orivon\'s own page for the names other browsers type, and leaves about:blank and view-source: of a web address alone', async () => {
  const { app, chrome } = await launchShell()
  try {
    await visit(app, chrome, here('/start'))
    const type = async (text: string): Promise<void> => {
      await chrome.click('#address')
      await chrome.fill('#address', text)
      await chrome.press('#address', 'Enter')
    }

    await type('chrome://version')
    expect(await addressReads(chrome, 'orivon://about')).toEqual({ ok: true, seen: expect.any(String) })
    await type('about:gpu')
    expect(await addressReads(chrome, 'orivon://about/gpu')).toEqual({ ok: true, seen: expect.any(String) })
    await type('chrome://history')
    expect(await addressReads(chrome, 'orivon://history')).toEqual({ ok: true, seen: expect.any(String) })

    await type('about:blank')
    await delay(1_500)
    const address = await chrome.evaluate(() => (document.querySelector('#address') as HTMLInputElement).value)
    expect(address.startsWith('orivon://')).toBe(false)

    const before = (await tabIds(chrome)).length
    await visit(app, chrome, here('/source'))
    await type(`view-source:${here('/source')}`)
    expect(await waitFor(async () => (await tabIds(chrome)).length === before + 1)).toBe(true)
    expect(await addressReads(chrome, `view-source:${here('/source')}`)).toEqual({ ok: true, seen: expect.any(String) })
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

const taskNames = async (page: Page): Promise<string[]> => await page.locator('.rows tr:not(.loading) .task-name').allTextContents()
const taskRow = (page: Page, name: string): ReturnType<Page['locator']> => page.locator('.rows tr', { has: page.locator('.task-name', { hasText: new RegExp(`^${name}$`) }) })

it('lists the processes with memory, sorts them, ends a tab\'s process and goes to a tab', async () => {
  const { app, chrome } = await launchShell()
  try {
    await visit(app, chrome, here('/one'))
    await chrome.evaluate((url) => { (window as unknown as { orivonShell: { newTab: (url: string) => void } }).orivonShell.newTab(url) }, here('/two'))
    expect((await waitForTab(chrome, { address: here('/two') })).ok).toBe(true)

    await runCommand(chrome, 'tasks.open')
    const tasks = await pageAt(app, 'orivon://tasks')
    await tasks.waitForSelector('.rows tr:not(.loading)')
    expect(await waitFor(async () => {
      const names = await taskNames(tasks)
      return names.includes('Tab: Page /one') && names.includes('Tab: Page /two') && names.includes('Browser')
    })).toBe(true)
    expect(await tasks.locator('h1').textContent()).toBe('Task manager')

    // A tab row has a memory figure and a process number; the footer adds them up.
    const one = taskRow(tasks, 'Tab: Page /one')
    const cells = await one.locator('td').allTextContents()
    expect(cells[1]).toMatch(/^\d+(\.\d)? (KB|MB|GB)$/)
    expect(cells[3]).toMatch(/^\d+$/)
    expect(await tasks.locator('tfoot td').nth(1).textContent()).toMatch(/(KB|MB|GB)$/)
    expect(await tasks.locator('th[aria-sort]').evaluateAll((all) => all.map((th) => th.getAttribute('aria-sort')))).toEqual(['none', 'descending', 'none', 'none'])

    // The processor figure is unknown on the first reading and real on the second, two seconds later.
    expect(await waitFor(async () => /%$/.test(await one.locator('td').nth(2).textContent() ?? ''), 6_000)).toBe(true)

    // The browser's own row cannot be ended, and says why.
    const end = tasks.getByRole('button', { name: 'End process' })
    expect(await end.isDisabled()).toBe(true)
    await taskRow(tasks, 'Browser').click()
    expect(await end.isDisabled()).toBe(true)
    expect(await end.getAttribute('title')).toBe('Ending this process would close Orivon.')

    // Sorting by Task goes A to Z and then back.
    await tasks.getByRole('button', { name: 'Task' }).click()
    expect(await tasks.locator('th').first().getAttribute('aria-sort')).toBe('ascending')
    const ascending = await taskNames(tasks)
    expect(ascending).toEqual([...ascending].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base', numeric: true })))
    await tasks.getByRole('button', { name: 'Task' }).click()
    expect(await tasks.locator('th').first().getAttribute('aria-sort')).toBe('descending')
    expect(await taskNames(tasks)).toEqual([...ascending].reverse())
    await tasks.getByRole('button', { name: 'Memory' }).click()
    expect(await tasks.locator('th').nth(1).getAttribute('aria-sort')).toBe('descending')

    // Keyboard: Down moves the selection.
    await one.click()
    expect(await one.getAttribute('aria-selected')).toBe('true')
    await shoot(tasks, 'tasks')
    await tasks.keyboard.press('ArrowDown')
    expect(await waitFor(async () => await one.getAttribute('aria-selected') === 'false')).toBe(true)
    await one.click()

    // Ending the tab's process: its strip tab reports the crash and the row loses its process.
    expect(await end.isDisabled()).toBe(false)
    await end.click()
    expect(await waitFor(async () => await chrome.evaluate(() =>
      Array.from(document.querySelectorAll('.tab.crashed .title')).map((el) => el.textContent).includes('Page /one')))).toBe(true)
    expect(await waitFor(async () => (await taskNames(tasks)).includes('Tab: Page /one (not running)'))).toBe(true)
    expect(await taskNames(tasks)).not.toContain('Tab: Page /one')
    expect(await taskNames(tasks)).toContain('Tab: Page /two')

    // A row that shows a tab takes the person to it.
    await taskRow(tasks, 'Tab: Page /one \\(not running\\)').dblclick()
    expect(await waitFor(async () => (await chrome.evaluate(() => document.querySelector('.tab.active .title')?.textContent)) === 'Page /one')).toBe(true)
    expect(mainOutput(app)).not.toContain('uncaught exception')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

it('opens the task manager with Shift+Escape', async () => {
  const { app, chrome } = await launchShell()
  try {
    await visit(app, chrome, here('/keys'))
    await pressKey(app, here('/keys'), 'Escape', ['shift'])
    const tasks = await pageAt(app, 'orivon://tasks')
    await tasks.waitForSelector('.rows tr:not(.loading)')
    expect(await taskNames(tasks)).toContain('Browser')
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)

/** The Console panel is selected when a tab of the tools reports itself selected under that name. */
async function selectedPanel (app: App, urlPart: string): Promise<string[]> {
  return await app.evaluate(async ({ webContents }, part) => {
    const target = webContents.getAllWebContents().find((contents) => contents.getURL().includes(part))
    const tools = target?.devToolsWebContents
    if (tools === null || tools === undefined || tools.isDestroyed()) return []
    const found = await tools.executeJavaScript(`(() => {
      const out = []
      const walk = (root) => {
        for (const el of root.querySelectorAll('*')) {
          if (el.getAttribute('role') === 'tab' && el.getAttribute('aria-selected') === 'true') out.push(el.id || el.getAttribute('aria-label') || '')
          if (el.shadowRoot) walk(el.shadowRoot)
        }
      }
      walk(document)
      return out
    })()`) as string[]
    return found
  }, urlPart)
}

it('opens the developer tools on the Console panel', async () => {
  const { app, chrome } = await launchShell()
  try {
    await visit(app, chrome, here('/console'))
    await runCommand(chrome, 'devtools.console')
    expect(await waitFor(async () => await app.evaluate(({ webContents }, part) =>
      webContents.getAllWebContents().find((contents) => contents.getURL().includes(part))?.isDevToolsOpened() === true, here('/console')))).toBe(true)
    let seen: string[] = []
    const selected = await waitFor(async () => {
      seen = await selectedPanel(app, here('/console')).catch(() => [])
      return seen.some((label) => /console/i.test(label))
    }, 15_000)
    expect({ selected, seen }).toEqual({ selected: true, seen: expect.arrayContaining([expect.stringMatching(/console/i)]) })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS)
