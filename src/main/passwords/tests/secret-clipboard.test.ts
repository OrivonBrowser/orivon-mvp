import { afterEach, describe, expect, it, vi } from 'vitest'
import { CLEAR_AFTER_MS, secretClipboard, WRITE_WAIT_MS } from '../secret-clipboard.js'
import type { ClipboardAccess } from '../secret-clipboard.js'

afterEach(() => { vi.useRealTimers() })

function fake (): { access: ClipboardAccess, held: () => string, scheduled: Array<{ run: () => Promise<void>, ms: number }>, later: (run: () => Promise<void>, ms: number) => void } {
  let text = ''
  const scheduled: Array<{ run: () => Promise<void>, ms: number }> = []
  return {
    access: { write: async (value) => { text = value; await Promise.resolve() }, read: async () => await Promise.resolve(text), clear: () => { text = '' } },
    held: () => text,
    scheduled,
    later: (run, ms) => { scheduled.push({ run, ms }) }
  }
}

describe('secretClipboard', () => {
  it('writes the text and clears it a minute later while it is still there', async () => {
    const { access, held, scheduled, later } = fake()
    expect(await secretClipboard(access, later).copy('pw')).toBe(true)
    expect(held()).toBe('pw')
    expect(scheduled.map((entry) => entry.ms)).toEqual([CLEAR_AFTER_MS])
    await scheduled[0]?.run()
    expect(held()).toBe('')
  })

  it('leaves the clipboard alone when the person copied something else since', async () => {
    const { access, held, scheduled, later } = fake()
    await secretClipboard(access, later).copy('pw')
    await access.write('something else')
    await scheduled[0]?.run()
    expect(held()).toBe('something else')
  })

  it('survives a clipboard that cannot be read when the minute is up', async () => {
    const { access, scheduled, later } = fake()
    await secretClipboard({ ...access, read: async () => { throw new Error('gone') } }, later).copy('pw')
    await expect(scheduled[0]?.run()).resolves.toBeUndefined()
  })

  it('answers after a second, and still schedules the clearing, when the clipboard never answers', async () => {
    vi.useFakeTimers()
    const { scheduled, later } = fake()
    const hung = secretClipboard({ write: async () => await new Promise<void>(() => {}), read: async () => await Promise.resolve(''), clear: () => {} }, later)
    const done = vi.fn()
    const pending = hung.copy('pw').then(done)
    await vi.advanceTimersByTimeAsync(WRITE_WAIT_MS - 1)
    expect(done).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(2)
    await pending
    expect(done).toHaveBeenCalledWith(true)
    expect(scheduled).toHaveLength(1)
  })

  it('says so when the clipboard cannot be written, and schedules nothing', async () => {
    const { access, scheduled, later } = fake()
    const copied = await secretClipboard({ ...access, write: async () => { throw new Error('no clipboard') } }, later).copy('pw')
    expect(copied).toBe(false)
    expect(scheduled).toEqual([])
  })

  it('leaves no timer behind once the text is written', async () => {
    vi.useFakeTimers()
    const { access, later } = fake()
    await secretClipboard(access, later).copy('pw')
    expect(vi.getTimerCount()).toBe(0)
  })
})
