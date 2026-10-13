import { describe, expect, it, vi } from 'vitest'
import { partitionScript, syncToolbarPartition } from '../toolbar-partition.js'

describe('which session the toolbar speaks to', () => {
  it('writes a script only for a session name, never for text that could run', () => {
    expect(partitionScript('persist:tunnel-profile')).toContain("setAttribute('partition', 'persist:tunnel-profile')")
    expect(partitionScript("x'); alert(1); ('")).toBeNull()
    expect(partitionScript('')).toBeNull()
  })

  it('tells a page once for a partition, and again after the page could not be told', async () => {
    const run = vi.fn(async () => undefined)
    const page = { isDestroyed: () => false, executeJavaScript: run }
    syncToolbarPartition(page, 'persist:direct-profile')
    syncToolbarPartition(page, 'persist:direct-profile')
    expect(run).toHaveBeenCalledTimes(1)
    syncToolbarPartition(page, 'orivon-extensions-default')
    expect(run).toHaveBeenCalledTimes(2)

    const failing = { isDestroyed: () => false, executeJavaScript: vi.fn(async () => { throw new Error('reloading') }) }
    syncToolbarPartition(failing, 'persist:direct-profile')
    await Promise.resolve()
    await Promise.resolve()
    syncToolbarPartition(failing, 'persist:direct-profile')
    expect(failing.executeJavaScript).toHaveBeenCalledTimes(2)
  })

  it('leaves a destroyed page alone', () => {
    const run = vi.fn(async () => undefined)
    syncToolbarPartition({ isDestroyed: () => true, executeJavaScript: run }, 'persist:direct-profile')
    expect(run).not.toHaveBeenCalled()
  })
})
