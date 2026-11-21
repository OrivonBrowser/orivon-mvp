import { describe, expect, it } from 'vitest'
import type { SubsystemFailure } from '../../registry.js'
import { endStart } from '../window-first.js'
import type { EndOfStart } from '../window-first.js'

const failure = (critical: boolean): SubsystemFailure => ({ name: 'route', phase: 'afterWindow', error: new Error('no settings'), critical })

/** The steps, each noting itself in `log`; `shown` is settled by the test. */
function steps (log: string[], over: Partial<EndOfStart> = {}): EndOfStart {
  return {
    afterWindow: async () => { log.push('afterWindow'); return [] },
    report: () => { log.push('report') },
    stopOnCritical: () => { log.push('stopOnCritical'); return false },
    openWebContent: async () => { log.push('openWebContent') },
    fill: async () => { log.push('fill') },
    started: () => { log.push('started') },
    mark: (name) => { log.push(`mark ${name}`) },
    ...over
  }
}

describe('the end of a start', () => {
  it('runs nothing until the first window is shown', async () => {
    const log: string[] = []
    let show: () => void = () => {}
    const shown = new Promise<void>((resolve) => { show = resolve })
    const ended = endStart(shown, steps(log))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(log).toEqual([])
    show()
    await ended
    expect(log[0]).toBe('afterWindow')
  })

  it('runs the tail, then opens web content, then fills the window, and answers a second launch last', async () => {
    const log: string[] = []
    await endStart(Promise.resolve(), steps(log))
    expect(log).toEqual(['afterWindow', 'mark afterWindowDone', 'report', 'stopOnCritical', 'openWebContent', 'fill', 'started'])
  })

  it('fills the window only once web content may load, however long the gate is held', async () => {
    const log: string[] = []
    let letIn: () => void = () => {}
    const gate = new Promise<void>((resolve) => { letIn = resolve })
    const ended = endStart(Promise.resolve(), steps(log, { openWebContent: async () => { log.push('openWebContent'); await gate; log.push('gate open') } }))
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(log).toEqual(['afterWindow', 'mark afterWindowDone', 'report', 'stopOnCritical', 'openWebContent'])
    letIn()
    await ended
    expect(log.slice(-4)).toEqual(['openWebContent', 'gate open', 'fill', 'started'])
  })

  it('never opens web content, fills or lets a launch in when a failure is critical', async () => {
    const log: string[] = []
    await endStart(Promise.resolve(), steps(log, {
      afterWindow: async () => { log.push('afterWindow'); return [failure(true)] },
      stopOnCritical: (failures) => { log.push(`stopOnCritical ${String(failures.length)}`); return true }
    }))
    expect(log).toEqual(['afterWindow', 'mark afterWindowDone', 'report', 'stopOnCritical 1'])
  })

  it('opens web content after a failure that is not critical', async () => {
    const log: string[] = []
    await endStart(Promise.resolve(), steps(log, { afterWindow: async () => { log.push('afterWindow'); return [failure(false)] } }))
    expect(log).toContain('openWebContent')
    expect(log).toContain('fill')
  })

  it('marks the start whatever the fill does, so a second launch is never stranded', async () => {
    const log: string[] = []
    await expect(endStart(Promise.resolve(), steps(log, { fill: async () => { throw new Error('restore failed') } }))).rejects.toThrow('restore failed')
    expect(log.at(-1)).toBe('started')
  })
})
