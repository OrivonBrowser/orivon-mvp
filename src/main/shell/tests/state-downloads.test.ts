import { describe, expect, it, vi } from 'vitest'
import type { DownloadEntry, DownloadState } from '../../downloads/download-types.js'
import { SHELL_STATE_PARTS } from '../shell-state-parts.js'
import { downloadsStatePart } from '../state/downloads.js'
import type { WindowContext } from '../window-context.js'

const entry = (id: string, state: DownloadState, extra: Partial<DownloadEntry> = {}): DownloadEntry => ({
  id, url: 'https://a.example/f', referrer: '', fileName: id, savePath: '', mime: '', total: 100, received: 50, state, startedAt: 1, danger: false, ...extra
})

function rig (mode: 'auto' | 'always' | 'never', list: DownloadEntry[] = []) {
  const listeners = new Set<(entry: DownloadEntry | null) => void>()
  let settingListener: (change: { key: string }) => void = () => {}
  let entries = list
  const stopDownloads = vi.fn()
  const stopSettings = vi.fn()
  const services = {
    settings: { get: () => mode, onChange: (next: typeof settingListener) => { settingListener = next; return stopSettings } },
    downloads: {
      list: () => entries,
      summary: () => {
        const running = entries.filter((each) => each.state === 'progressing' || each.state === 'paused')
        const total = running.reduce((sum, each) => sum + each.total, 0)
        return { active: running.length, fraction: total > 0 ? running.reduce((sum, each) => sum + each.received, 0) / total : null, any: entries.length > 0 }
      },
      onChange: (next: (entry: DownloadEntry | null) => void) => { listeners.add(next); return stopDownloads }
    }
  }
  const ctx = { window: {}, services } as unknown as WindowContext
  return { ctx, set: (next: DownloadEntry[]) => { entries = next }, fire: (each: DownloadEntry | null) => { for (const listener of listeners) listener(each) }, setting: (key: string) => { settingListener({ key }) }, stopDownloads, stopSettings }
}

const tabs = { tabs: [], activeTabId: null }
const read = (ctx: WindowContext): Record<string, unknown> => ({ ...(downloadsStatePart.read(ctx, tabs).downloads) })

describe('the downloads state part', () => {
  it('is registered', () => {
    expect(SHELL_STATE_PARTS).toContain(downloadsStatePart)
  })

  it('shows the button in "always" and never in "never", whatever is listed', () => {
    expect(read(rig('always').ctx)).toMatchObject({ shown: true, active: 0, attention: 'none' })
    const never = rig('never', [entry('a', 'progressing')])
    expect(read(never.ctx).shown).toBe(false)
  })

  it('shows the button in "auto" while something runs, and not for a list a previous run left', () => {
    expect(read(rig('auto', [entry('old', 'completed')]).ctx).shown).toBe(false)
    expect(read(rig('auto', [entry('a', 'progressing')]).ctx)).toMatchObject({ shown: true, active: 1, fraction: 0.5 })
  })

  it('keeps showing it in "auto" after this run downloaded something, until the list is empty', () => {
    const made = rig('auto')
    downloadsStatePart.watch?.(made.ctx, vi.fn())
    expect(read(made.ctx).shown).toBe(false)
    made.set([entry('a', 'progressing')])
    made.fire(entry('a', 'progressing'))
    made.set([entry('a', 'completed')])
    made.fire(entry('a', 'completed'))
    expect(read(made.ctx)).toMatchObject({ shown: true, active: 0, attention: 'done' })
    made.set([])
    made.fire(null)
    expect(read(made.ctx).shown).toBe(false)
  })

  it('says when everything running is paused', () => {
    const made = rig('always', [entry('a', 'paused'), entry('b', 'paused')])
    expect(read(made.ctx)).toMatchObject({ active: 2, paused: true })
  })

  it('has a null fraction when no running download knows its size', () => {
    expect(read(rig('always', [entry('a', 'progressing', { total: 0 })]).ctx).fraction).toBeNull()
  })

  it('warns while a file is held', () => {
    const made = rig('auto', [entry('a', 'progressing')])
    downloadsStatePart.watch?.(made.ctx, vi.fn())
    made.fire(entry('a', 'held'))
    expect(read(made.ctx).attention).toBe('warn')
  })

  it('pushes on a download change, folded, and on a change of its setting only, and stops with the window', () => {
    vi.useFakeTimers()
    try {
      const made = rig('auto')
      const push = vi.fn()
      const stop = downloadsStatePart.watch?.(made.ctx, push)
      made.fire(entry('a', 'progressing'))
      made.fire(entry('a', 'progressing'))
      made.fire(entry('a', 'progressing'))
      expect(push).toHaveBeenCalledTimes(1)
      vi.advanceTimersByTime(300)
      expect(push).toHaveBeenCalledTimes(2)
      made.setting('appearance.theme')
      expect(push).toHaveBeenCalledTimes(2)
      made.setting('toolbar.downloads')
      expect(push).toHaveBeenCalledTimes(3)
      stop?.()
      expect(made.stopDownloads).toHaveBeenCalled()
      expect(made.stopSettings).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('counts the Downloads page in front as looking at what arrived', () => {
    const made = rig('auto', [entry('a', 'progressing')])
    downloadsStatePart.watch?.(made.ctx, vi.fn())
    made.fire(entry('a', 'completed'))
    expect(read(made.ctx).attention).toBe('done')
    const onPage = { tabs: [{ id: 't', url: 'orivon://downloads/' }], activeTabId: 't' }
    expect(downloadsStatePart.read(made.ctx, onPage as never).downloads?.attention).toBe('none')
  })
})
