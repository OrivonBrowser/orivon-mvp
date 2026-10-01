import { describe, expect, it } from 'vitest'
import { markResponsive, markUnresponsive, troubleOf, waiveUnresponsive } from '../sad-tab-state.js'
import type { TabRecord } from '../../shell/tab-types.js'

const record = (crashed?: string | null): TabRecord => ({ crashed }) as unknown as TabRecord

describe('the trouble of a tab', () => {
  it('is none for a healthy tab, with the field absent or null', () => {
    expect(troubleOf(record())).toBeNull()
    expect(troubleOf(record(null))).toBeNull()
  })

  it('is the crash reason on the record', () => {
    expect(troubleOf(record('oom'))).toEqual({ kind: 'crashed', reason: 'oom' })
  })

  it('is a hang from the unresponsive event until the page answers', () => {
    const tab = record()
    markUnresponsive(tab)
    expect(troubleOf(tab)).toEqual({ kind: 'unresponsive' })
    markResponsive(tab)
    expect(troubleOf(tab)).toBeNull()
  })

  it('stays quiet once the person chose to wait, until the next unresponsive event', () => {
    const tab = record()
    markUnresponsive(tab)
    waiveUnresponsive(tab)
    expect(troubleOf(tab)).toBeNull()
    markUnresponsive(tab)
    expect(troubleOf(tab)).toEqual({ kind: 'unresponsive' })
  })

  it('does not invent a hang by waiving a page that is not hung', () => {
    const tab = record()
    waiveUnresponsive(tab)
    markUnresponsive(tab)
    expect(troubleOf(tab)).toEqual({ kind: 'unresponsive' })
  })

  it('puts a crash before a hang', () => {
    const tab = record('crashed')
    markUnresponsive(tab)
    expect(troubleOf(tab)).toEqual({ kind: 'crashed', reason: 'crashed' })
  })
})
