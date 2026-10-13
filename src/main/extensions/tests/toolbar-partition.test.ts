import { describe, expect, it, vi } from 'vitest'
import { partitionScript, syncToolbarPartition } from '../toolbar-partition.js'

describe('which session the toolbar speaks to', () => {
  it('writes a script only for a session name, never for text that could run', () => {
    expect(partitionScript('persist:tunnel-profile')).toContain("setAttribute('partition', 'persist:tunnel-profile')")
    expect(partitionScript("x'); alert(1); ('")).toBeNull()
    expect(partitionScript('')).toBeNull()
  })

  it('tells a page once for a partition, and again for another', () => {
    const run = vi.fn(async () => undefined)
    const page = { isDestroyed: () => false, executeJavaScript: run }
    syncToolbarPartition(page, 'persist:direct-profile')
    syncToolbarPartition(page, 'persist:direct-profile')
    expect(run).toHaveBeenCalledTimes(1)
    syncToolbarPartition(page, 'orivon-extensions-default')
    expect(run).toHaveBeenCalledTimes(2)
  })

  it('tells a page that reloaded what it showed, since the reloaded page draws the default session\'s list', () => {
    const run = vi.fn(async (_script: string) => undefined)
    let loaded: () => void = () => {}
    const page = { isDestroyed: () => false, executeJavaScript: run, on: ((event: string, listener: () => void) => { if (event === 'did-finish-load') loaded = listener }) as never }
    syncToolbarPartition(page, 'persist:tunnel-profile')
    syncToolbarPartition(page, 'persist:direct-profile')
    run.mockClear()
    loaded()
    expect(run).toHaveBeenCalledTimes(1)
    expect(String(run.mock.calls[0]?.[0])).toContain('persist:direct-profile')
  })

  it('leaves a destroyed page alone', () => {
    const run = vi.fn(async () => undefined)
    syncToolbarPartition({ isDestroyed: () => true, executeJavaScript: run }, 'persist:direct-profile')
    expect(run).not.toHaveBeenCalled()
  })
})
