import { describe, expect, it, vi } from 'vitest'
import type { OrivonInternal } from '../../shared/bridge.js'
import { ImportState } from '../state.js'

const SOURCES = [{ id: '0', key: 'chrome', browser: 'Chrome', profile: 'Person 1' }, { id: '1', key: 'firefox', browser: 'Firefox', profile: 'default' }]

function setup (replies: Record<string, unknown>) {
  let listener: (topic: string, payload: unknown) => void = () => {}
  const request = vi.fn(async (_domain: string, command: unknown) => {
    const reply = replies[(command as { type: string }).type]
    return typeof reply === 'function' ? (reply as (command: unknown) => unknown)(command) : reply
  })
  const bridge: OrivonInternal = { page: 'import', request, onEvent: (next) => { listener = next; return () => {} }, platform: 'linux' }
  const state = new ImportState(bridge)
  return { state, request, push: (topic: string, payload: unknown) => { listener(topic, payload) } }
}

const DETECTED = { private: false, sources: SOURCES, historyOn: true, manager: true }
const RESULT = { bookmarks: 2, pages: 3, skipped: 0, known: 0, target: 'bar' }

describe('ImportState', () => {
  it('goes from detecting to choosing with the first row chosen and both boxes ticked', async () => {
    const { state } = setup({ detect: DETECTED })
    expect(state.step).toBe('detecting')
    await state.detect()
    expect(state.step).toBe('choosing')
    expect(state.selected).toBe(0)
    expect(state.bookmarks && state.history && state.canImport).toBe(true)
    expect(state.source?.browser).toBe('Chrome')
  })

  it('has only the file row when nothing was found, and can import from it', async () => {
    const { state } = setup({ detect: { ...DETECTED, sources: [] } })
    await state.detect()
    expect(state.isFile).toBe(true)
    expect(state.canImport).toBe(true)
  })

  it('shows the private message when main says the window is private', async () => {
    const { state } = setup({ detect: { private: true } })
    await state.detect()
    expect(state.step).toBe('private')
  })

  it('moves the choice within the rows, the file row last', async () => {
    const { state } = setup({ detect: DETECTED })
    await state.detect()
    state.select(1)
    expect(state.selected).toBe(1)
    state.select(99)
    expect(state.selected).toBe(2)
    expect(state.isFile).toBe(true)
    state.select(-5)
    expect(state.selected).toBe(0)
  })

  it('cannot import with both boxes cleared, and ignores the history box while history is off', async () => {
    const { state } = setup({ detect: { ...DETECTED, historyOn: false } })
    await state.detect()
    state.tick('bookmarks', false)
    expect(state.canImport).toBe(false)
    state.tick('history', true)
    expect(state.canImport).toBe(false)
    state.tick('bookmarks', true)
    expect(state.canImport).toBe(true)
  })

  it('follows history being turned on or off in Settings while the page is open', async () => {
    const { state, push } = setup({ detect: { ...DETECTED, historyOn: false } })
    await state.detect()
    state.tick('bookmarks', false)
    state.tick('history', true)
    expect(state.canImport).toBe(false)
    push('settings.changed', { key: 'history.remember', value: true })
    expect(state.canImport).toBe(true)
    push('settings.changed', { key: 'appearance.theme', value: 'dark' })
    push('settings.changed', { key: 'history.remember', value: false })
    expect(state.canImport).toBe(false)
  })

  it('sends what was chosen and ticked, follows the progress and ends on the result', async () => {
    const { state, request, push } = setup({ detect: DETECTED, run: { result: RESULT } })
    await state.detect()
    state.select(1)
    state.tick('history', false)
    const run = state.start()
    expect(state.step).toBe('running')
    push('import.progress', 'history')
    expect(state.phase).toBe('history')
    await run
    expect(request).toHaveBeenLastCalledWith('import', { type: 'run', id: '1', bookmarks: true, history: false })
    expect(state.step).toBe('done')
    expect(state.result).toEqual(RESULT)
    expect(state.from).toBe('Firefox')
  })

  it('asks main to open the file dialog for the file row, and goes back to the choice when it is cancelled', async () => {
    const { state, request } = setup({ detect: { ...DETECTED, sources: [] }, runHtml: { cancelled: true } })
    await state.detect()
    await state.start()
    expect(request).toHaveBeenLastCalledWith('import', { type: 'runHtml' })
    expect(state.step).toBe('choosing')
  })

  it('ends on an error when the result carries one, keeping what was imported before it', async () => {
    const { state } = setup({ detect: DETECTED, run: { result: { ...RESULT, pages: 0, error: 'locked' } } })
    await state.detect()
    await state.start()
    expect(state.step).toBe('error')
    expect(state.error).toBe('locked')
    expect(state.result?.bookmarks).toBe(2)
  })

  it('says another import is running, instead of calling the profile unreadable, when main answers busy', async () => {
    const { state } = setup({ detect: DETECTED, run: { busy: true } })
    await state.detect()
    await state.start()
    expect(state.step).toBe('error')
    expect(state.error).toBe('busy')
  })

  it('ends on an error when main does not answer, and goes back to the choice on "Try again"', async () => {
    const { state } = setup({ detect: DETECTED, run: undefined })
    await state.detect()
    await state.start()
    expect(state.step).toBe('error')
    expect(state.error).toBe('unreadable')
    state.again()
    expect(state.step).toBe('choosing')
    expect(state.error).toBeNull()
    expect(state.selected).toBe(0)
  })

  it('ends on the private message when main says so during a run', async () => {
    const { state } = setup({ detect: DETECTED, run: { private: true } })
    await state.detect()
    await state.start()
    expect(state.step).toBe('private')
  })

  it('does not start when nothing can be imported', async () => {
    const { state, request } = setup({ detect: DETECTED })
    await state.detect()
    state.tick('bookmarks', false)
    state.tick('history', false)
    await state.start()
    expect(request).toHaveBeenCalledTimes(1)
  })

  it('asks main to open the bookmark manager', async () => {
    const { state, request } = setup({ detect: DETECTED, open: { ok: true } })
    await state.openManager()
    expect(request).toHaveBeenCalledWith('import', { type: 'open', target: 'bookmarks' })
  })
})
