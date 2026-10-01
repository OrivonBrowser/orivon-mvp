import type { WebContents } from 'electron'
import { describe, expect, it, vi } from 'vitest'
import { importDomain } from '../import-domain.js'
import type { ImportHost } from '../import-domain.js'
import type { ImportResult, ImportSource } from '../import-types.js'

const SOURCES: ImportSource[] = [
  { browser: 'chrome', family: 'chromium', profile: 'Person 1', dir: '/secret/path/Default' },
  { browser: 'firefox', family: 'firefox', profile: 'default', dir: '/secret/path/ff' }
]
const RESULT: ImportResult = { bookmarks: 2, pages: 3, skipped: 0, known: 0, target: 'bar' }

function setup (overrides: Partial<ImportHost> = {}) {
  const host: ImportHost = {
    isPrivate: false,
    detect: vi.fn(async () => SOURCES),
    historyOn: () => true,
    managerAvailable: () => true,
    run: vi.fn(async () => RESULT),
    runFile: vi.fn(async () => RESULT),
    openManager: vi.fn(),
    ...overrides
  }
  const domain = importDomain(host)
  const call = async (command: unknown): Promise<unknown> => await domain.handle(command, { page: 'import', contents: {} as WebContents })
  return { host, domain, call }
}

describe('the import domain', () => {
  it('is for the Import page only', () => {
    expect(setup().domain.pages).toEqual(['import'])
  })

  it('lists the profiles by an opaque id and names no path', async () => {
    const { call } = setup()
    const reply = await call({ type: 'detect' })
    expect(reply).toEqual({
      private: false,
      sources: [{ id: '0', key: 'chrome', browser: 'Chrome', profile: 'Person 1' }, { id: '1', key: 'firefox', browser: 'Firefox', profile: 'default' }],
      historyOn: true,
      manager: true
    })
    expect(JSON.stringify(reply)).not.toContain('/secret')
  })

  it('runs the profile the id names, with what was ticked', async () => {
    const { call, host } = setup()
    await call({ type: 'detect' })
    expect(await call({ type: 'run', id: '1', bookmarks: true, history: false })).toEqual({ result: RESULT })
    expect(host.run).toHaveBeenCalledWith(SOURCES[1], { bookmarks: true, history: false })
  })

  it('does not import history while it is off, whatever the page asks', async () => {
    const { call, host } = setup({ historyOn: () => false })
    await call({ type: 'detect' })
    await call({ type: 'run', id: '0', bookmarks: true, history: true })
    expect(host.run).toHaveBeenCalledWith(SOURCES[0], { bookmarks: true, history: false })
    expect(await call({ type: 'run', id: '0', bookmarks: false, history: true })).toBeUndefined()
  })

  it.each([
    undefined, null, 5, 'x', {}, { type: 'nothing' }, { type: 'run' }, { type: 'run', id: '7', bookmarks: true, history: true },
    { type: 'run', id: '-1', bookmarks: true, history: true }, { type: 'run', id: '0.5', bookmarks: true, history: true }, { type: 'run', id: 0, bookmarks: true, history: true },
    { type: 'run', id: '0', bookmarks: 'yes', history: true }, { type: 'run', id: '0', bookmarks: true }, { type: 'run', id: '0', bookmarks: false, history: false },
    { type: 'run', id: '__proto__', bookmarks: true, history: true }, { type: 'run', path: '/etc/passwd', bookmarks: true, history: true },
    { type: 'open' }, { type: 'open', target: 'history' }
  ])('refuses a request of the wrong shape: %j', async (command) => {
    const { call, host } = setup()
    await call({ type: 'detect' })
    expect(await call(command)).toBeUndefined()
    expect(host.run).not.toHaveBeenCalled()
    expect(host.openManager).not.toHaveBeenCalled()
  })

  it('refuses a run before any detection', async () => {
    const { call, host } = setup()
    expect(await call({ type: 'run', id: '0', bookmarks: true, history: true })).toBeUndefined()
    expect(host.run).not.toHaveBeenCalled()
  })

  it('runs one import at a time', async () => {
    let finish: (result: ImportResult) => void = () => {}
    let started = 0
    const { call } = setup({ run: () => { started += 1; return started === 1 ? new Promise((resolve) => { finish = resolve }) : Promise.resolve(RESULT) } })
    await call({ type: 'detect' })
    const first = call({ type: 'run', id: '0', bookmarks: true, history: true })
    expect(await call({ type: 'run', id: '1', bookmarks: true, history: true })).toEqual({ busy: true })
    expect(await call({ type: 'runHtml' })).toEqual({ busy: true })
    finish(RESULT)
    expect(await first).toEqual({ result: RESULT })
    expect(await call({ type: 'run', id: '0', bookmarks: true, history: true })).toBeDefined()
  })

  it('imports a file through the dialog, and answers a cancelled dialog as such', async () => {
    const a = setup()
    expect(await a.call({ type: 'runHtml' })).toEqual({ result: RESULT })
    const b = setup({ runFile: async () => undefined })
    expect(await b.call({ type: 'runHtml' })).toEqual({ cancelled: true })
  })

  it('opens the bookmark manager only when there is one', async () => {
    const a = setup()
    expect(await a.call({ type: 'open', target: 'bookmarks' })).toEqual({ ok: true })
    expect(a.host.openManager).toHaveBeenCalledTimes(1)
    const b = setup({ managerAvailable: () => false })
    expect(await b.call({ type: 'open', target: 'bookmarks' })).toBeUndefined()
  })

  it('reads nothing and answers the same to every request in a private window', async () => {
    const { call, host } = setup({ isPrivate: true })
    for (const command of [{ type: 'detect' }, { type: 'run', id: '0', bookmarks: true, history: true }, { type: 'runHtml' }, { type: 'open', target: 'bookmarks' }, undefined, { type: 'nothing' }]) {
      expect(await call(command)).toEqual({ private: true })
    }
    expect(host.detect).not.toHaveBeenCalled()
    expect(host.run).not.toHaveBeenCalled()
    expect(host.runFile).not.toHaveBeenCalled()
    expect(host.openManager).not.toHaveBeenCalled()
  })
})
