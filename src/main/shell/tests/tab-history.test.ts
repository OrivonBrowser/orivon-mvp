import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { carryHistory, restoreHistory } from '../tab-history.js'

function contents (entries: Array<{ url: string, title: string, pageState?: string }> = [], index = 0): { wc: WebContents, calls: string[], restore: ReturnType<typeof vi.fn> } {
  const calls: string[] = []
  const restore = vi.fn(async () => { calls.push('restore') })
  const wc = {
    stop: () => { calls.push('stop') },
    reload: () => { calls.push('reload') },
    navigationHistory: { restore, getAllEntries: () => entries, getActiveIndex: () => index }
  } as unknown as WebContents
  return { wc, calls, restore }
}

describe('restoreHistory', () => {
  it('stops the load the tab began, restores the list, then loads the restored entry once', () => {
    const { wc, calls, restore } = contents()
    restoreHistory(wc, [{ url: 'https://a.example/1', title: 'One' }, { url: 'https://a.example/2', title: 'Two' }], 1)
    expect(calls).toEqual(['stop', 'restore', 'reload'])
    expect(restore).toHaveBeenCalledExactlyOnceWith({ entries: [{ url: 'https://a.example/1', title: 'One' }, { url: 'https://a.example/2', title: 'Two' }], index: 1 })
  })

  it('leaves the tab on its address when the list cannot be restored', () => {
    const { wc, restore } = contents()
    restore.mockImplementation(() => { throw new Error('refused') })
    expect(() => { restoreHistory(wc, [{ url: 'https://a.example/1', title: '' }], 0) }).not.toThrow()
  })
})

describe('carryHistory', () => {
  it('gives the copy the same pages by the same sequence, and only their address and title', () => {
    const from = contents([{ url: 'https://a.example/1', title: 'One', pageState: 'SECRET' }, { url: 'https://a.example/2', title: 'Two', pageState: 'SECRET' }], 1)
    const to = contents()
    carryHistory(from.wc, to.wc)
    expect(to.calls).toEqual(['stop', 'restore', 'reload'])
    expect(to.restore).toHaveBeenCalledExactlyOnceWith({ entries: [{ url: 'https://a.example/1', title: 'One' }, { url: 'https://a.example/2', title: 'Two' }], index: 1 })
  })

  it('carries nothing for a history of one page', () => {
    const to = contents()
    carryHistory(contents([{ url: 'https://a.example/1', title: '' }], 0).wc, to.wc)
    expect(to.calls).toEqual([])
  })
})
