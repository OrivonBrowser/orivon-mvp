import { describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import { carryHistory, restoreHistory, withoutShellPages } from '../tab-history.js'

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
    expect(restoreHistory(wc, [{ url: 'https://a.example/1', title: '' }], 0)).toBe(false)
  })
})

const DASHBOARD = { url: 'orivon-shell://renderer/newtab/index.html', title: 'New tab' }

describe('withoutShellPages', () => {
  const one = { url: 'https://a.example/1', title: 'One', pageState: 'p' }
  const two = { url: 'https://a.example/2', title: 'Two' }

  it('drops the shell\'s pages and moves the index to the entry that was shown', () => {
    expect(withoutShellPages([DASHBOARD, one, DASHBOARD, two], 3)).toEqual({ entries: [one, two], index: 1 })
  })

  it('answers null when the shown entry is a shell page or the index is out of range', () => {
    expect(withoutShellPages([one, DASHBOARD], 1)).toBeNull()
    expect(withoutShellPages([one], 4)).toBeNull()
  })
})

describe('a history that holds the shell\'s own pages', () => {
  it('is restored without them, the index shifted to the page that was shown', () => {
    const { wc, restore } = contents()
    expect(restoreHistory(wc, [DASHBOARD, { url: 'https://a.example/1', title: 'One' }, DASHBOARD, { url: 'https://a.example/2', title: 'Two' }], 3)).toBe(true)
    expect(restore).toHaveBeenCalledExactlyOnceWith({ entries: [{ url: 'https://a.example/1', title: 'One' }, { url: 'https://a.example/2', title: 'Two' }], index: 1 })
  })

  it('is not restored at all when the page shown is one of them', () => {
    const { wc, calls, restore } = contents()
    expect(restoreHistory(wc, [{ url: 'https://a.example/1', title: 'One' }, DASHBOARD], 1)).toBe(false)
    expect(calls).toEqual([])
    expect(restore).not.toHaveBeenCalled()
  })

  it('is carried to a copy as the pages after the dashboard, so Back cannot reach it', () => {
    const from = contents([DASHBOARD, { url: 'https://a.example/1', title: 'One' }], 1)
    const to = contents()
    expect(carryHistory(from.wc, to.wc)).toBe(true)
    expect(to.restore).toHaveBeenCalledExactlyOnceWith({ entries: [{ url: 'https://a.example/1', title: 'One' }], index: 0 })
  })

  it('carries nothing from a tab that shows the dashboard', () => {
    const from = contents([{ url: 'https://a.example/1', title: 'One' }, DASHBOARD], 1)
    const to = contents()
    expect(carryHistory(from.wc, to.wc)).toBe(false)
    expect(to.calls).toEqual([])
  })

  it('carries nothing before a swap made from the dashboard, and the new tab loads its own address', () => {
    const from = contents([DASHBOARD], 0)
    const to = contents()
    expect(carryHistory(from.wc, to.wc, 'https://a.example/1')).toBe(false)
    expect(to.calls).toEqual([])
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
