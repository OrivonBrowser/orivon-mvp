import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { WebContents } from 'electron'
import type { AskQuestion } from '../question/ask-question.js'

vi.mock('electron', () => ({}))
const { forgetNavigation, leaveAllowed, startNavigation } = await import('../leave-page-prompt.js')

const flush = async (): Promise<void> => { await new Promise((resolve) => { setTimeout(resolve, 0) }) }
const contents = (): WebContents => ({ isDestroyed: () => false }) as unknown as WebContents
const answering = (response: number): ReturnType<typeof vi.fn> & AskQuestion => vi.fn(async () => ({ response, checkboxChecked: false })) as never

beforeEach(() => { vi.useFakeTimers({ toFake: ['Date'] }) })
afterEach(() => { vi.useRealTimers() })

describe('a page that asks before it is left', () => {
  it('stays put while the person is asked in the tab\'s panel, Leave guarded and Stay the default', () => {
    const wc = contents()
    const ask = answering(1)

    expect(leaveAllowed(wc, ask)).toBe(false)

    expect(ask).toHaveBeenCalledWith({ contents: wc }, expect.objectContaining({ kind: 'confirm', buttons: ['Leave', 'Stay'], cancelId: 1, guarded: [0], focus: 1 }), { endOnNavigation: true })
  })

  it('does not stack a second question on the first', () => {
    const wc = contents()
    const ask = vi.fn(() => new Promise<never>(() => {})) as unknown as AskQuestion
    leaveAllowed(wc, ask)
    expect(leaveAllowed(wc, ask)).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('lets exactly one later attempt through after Leave', async () => {
    const wc = contents()
    leaveAllowed(wc, answering(0))
    await flush()

    const ask = answering(1)
    expect(leaveAllowed(wc, ask)).toBe(true)
    expect(ask).not.toHaveBeenCalled()
    expect(leaveAllowed(wc, ask)).toBe(false)
    expect(ask).toHaveBeenCalledTimes(1)
  })

  it('lets nothing through after Stay, or after the way out', async () => {
    const wc = contents()
    leaveAllowed(wc, answering(1))
    await flush()
    expect(leaveAllowed(wc, answering(1))).toBe(false)
  })

  it('forgets a Leave nobody followed up', async () => {
    const wc = contents()
    leaveAllowed(wc, answering(0))
    await flush()
    vi.setSystemTime(Date.now() + 21_000)
    expect(leaveAllowed(wc, answering(1))).toBe(false)
  })

  it('treats a rejected question as Stay, and asks again next time', async () => {
    const wc = contents()
    leaveAllowed(wc, vi.fn(async () => { throw new Error('no window') }) as unknown as AskQuestion)
    await flush()
    expect(leaveAllowed(wc, answering(1))).toBe(false)
  })

  it('keeps one tab\'s Leave from opening another tab', async () => {
    const a = contents()
    const b = contents()
    leaveAllowed(a, answering(0))
    await flush()
    expect(leaveAllowed(b, answering(1))).toBe(false)
  })
})

describe('a navigation the shell started', () => {
  it('runs at once, and runs again when the person chooses Leave', async () => {
    const wc = contents()
    const go = vi.fn()

    startNavigation(wc, go)
    expect(go).toHaveBeenCalledTimes(1)
    expect(leaveAllowed(wc, answering(0))).toBe(false)
    await flush()

    expect(go).toHaveBeenCalledTimes(2)
  })

  it('is not run again after Stay', async () => {
    const wc = contents()
    const go = vi.fn()
    startNavigation(wc, go)
    leaveAllowed(wc, answering(1))
    await flush()
    expect(go).toHaveBeenCalledTimes(1)
  })

  it('is not run again when the page asked on its own, long after', async () => {
    const wc = contents()
    const go = vi.fn()
    startNavigation(wc, go)
    vi.setSystemTime(Date.now() + 3000)

    leaveAllowed(wc, answering(0))
    await flush()

    expect(go).toHaveBeenCalledTimes(1)
  })

  it('is not run again once a new document began: it ran', async () => {
    const wc = contents()
    const go = vi.fn()
    startNavigation(wc, go)
    forgetNavigation(wc)

    leaveAllowed(wc, answering(0))
    await flush()

    expect(go).toHaveBeenCalledTimes(1)
  })

  it('is not run twice by the attempt it let through', async () => {
    const wc = contents()
    const go = vi.fn()
    startNavigation(wc, go)
    leaveAllowed(wc, answering(0))
    await flush()
    // The replay's own unload check passes without a question and without another run.
    expect(leaveAllowed(wc, answering(1))).toBe(true)
    expect(go).toHaveBeenCalledTimes(2)
  })
})
