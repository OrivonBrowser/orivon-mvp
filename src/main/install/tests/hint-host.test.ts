import { describe, expect, it, vi } from 'vitest'
import { headlessHost } from '../hint-host.js'

describe('headlessHost: contents no window holds as a tab', () => {
  it('draws nothing, offers no retry, and reloads the contents to enter', async () => {
    const reload = vi.fn()
    const host = headlessHost({ reload, isDestroyed: () => false })
    await expect(host.sheet({ kind: 'download-failed', name: 'L', reason: 'x' })).resolves.toBe('leave')
    host.plain()
    host.end()
    expect(reload).not.toHaveBeenCalled()
    host.enter()
    expect(reload).toHaveBeenCalledOnce()
  })

  it('does not reload contents that are gone', () => {
    const reload = vi.fn()
    headlessHost({ reload, isDestroyed: () => true }).enter()
    expect(reload).not.toHaveBeenCalled()
  })
})
