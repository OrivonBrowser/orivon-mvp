import { afterEach, describe, expect, it, vi } from 'vitest'
import type { SubsystemFailure } from '../../registry.js'
import { endStart, startTail } from '../window-first.js'
import type { TailSteps } from '../window-first.js'

const failure = (critical: boolean): SubsystemFailure => ({ name: 'route', phase: 'afterWindow', error: new Error('no settings'), critical })

/** The tail's steps, each noting itself in `log`. */
function steps (log: string[], over: Partial<TailSteps> = {}): TailSteps {
  return {
    afterWindow: async () => { log.push('afterWindow'); return [] },
    report: () => { log.push('report') },
    stopOnCritical: () => { log.push('stopOnCritical'); return false },
    openWebContent: async () => { log.push('openWebContent') },
    mark: (name) => { log.push(`mark ${name}`) },
    ...over
  }
}

const filled = (log: string[]): Promise<{ readonly fill: () => Promise<void> }> => Promise.resolve({ fill: async () => { log.push('fill') } })
const settles = async (promise: Promise<unknown>): Promise<boolean> => await Promise.race([promise.then(() => true), new Promise<boolean>((resolve) => { setTimeout(() => { resolve(false) }, 10) })])

afterEach(() => { vi.useRealTimers() })

describe('the tail', () => {
  it('starts at once and is not awaited by whoever starts it', async () => {
    const log: string[] = []
    let finish: () => void = () => {}
    const tail = startTail(steps(log, { afterWindow: async () => { log.push('afterWindow'); await new Promise<void>((resolve) => { finish = resolve }); return [] } }))
    expect(log).toEqual(['afterWindow'])
    expect(await settles(tail)).toBe(false)
    finish()
    await tail
    expect(log).toEqual(['afterWindow', 'mark afterWindowDone', 'report', 'stopOnCritical', 'openWebContent'])
  })

  it('opens web content after the tail, in this order, and says the start goes on', async () => {
    const log: string[] = []
    const outcome = await startTail(steps(log))
    expect(outcome).toEqual({ stopped: false })
    expect(log).toEqual(['afterWindow', 'mark afterWindowDone', 'report', 'stopOnCritical', 'openWebContent'])
  })

  it('opens web content after a failure that is not critical', async () => {
    const log: string[] = []
    await startTail(steps(log, { afterWindow: async () => { log.push('afterWindow'); return [failure(false)] } }))
    expect(log).toContain('openWebContent')
  })

  it('never opens web content when a failure is critical', async () => {
    const log: string[] = []
    const tail = startTail(steps(log, {
      afterWindow: async () => { log.push('afterWindow'); return [failure(true)] },
      stopOnCritical: (failures) => { log.push(`stopOnCritical ${String(failures.length)}`); return true }
    }))
    expect(await tail).toEqual({ stopped: true })
    expect(log).toEqual(['afterWindow', 'mark afterWindowDone', 'report', 'stopOnCritical 1'])
  })

  it('never rejects: a throw no subsystem caught is a critical failure of the start, said and ended like one', async () => {
    const log: string[] = []
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      const reported: SubsystemFailure[][] = []
      const tail = startTail(steps(log, {
        afterWindow: async () => { throw new Error('runSerial broke') },
        report: (failures) => { reported.push([...failures]) },
        stopOnCritical: (failures) => { log.push(`stopOnCritical ${String(failures[0]?.critical)}`); return true }
      }))
      // Awaited a good while after it settled, as the start awaits it, hundreds of milliseconds after it was made.
      await new Promise((resolve) => setTimeout(resolve, 20))
      expect(await tail).toEqual({ stopped: true })
      expect(reported[0]?.[0]).toMatchObject({ name: 'startup', phase: 'afterWindow', critical: true })
      expect(log).toEqual(['stopOnCritical true'])
      await new Promise((resolve) => setTimeout(resolve, 10))
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })

  it('never rejects even when saying the failure throws, and stops the start', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    const tail = startTail(steps([], { afterWindow: async () => { throw new Error('first') }, stopOnCritical: () => { throw new Error('dialog failed') } }))
    expect(await tail).toEqual({ stopped: true })
    expect(error).toHaveBeenCalled()
    error.mockRestore()
  })

  it('never rejects when the gate itself throws', async () => {
    const log: string[] = []
    const tail = startTail(steps(log, { openWebContent: async () => { throw new Error('gate broke') }, stopOnCritical: () => { log.push('stopOnCritical'); return true } }))
    expect(await tail).toEqual({ stopped: true })
  })

  it('holds the start for as long as the gate is held shut', async () => {
    const log: string[] = []
    let letIn: () => void = () => {}
    const gate = new Promise<void>((resolve) => { letIn = resolve })
    const tail = startTail(steps(log, { openWebContent: async () => { log.push('openWebContent'); await gate; log.push('gate open') } }))
    const ended = endStart(tail, filled(log), () => { log.push('started') })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(log.at(-1)).toBe('openWebContent')
    letIn()
    await ended
    expect(log.slice(-4)).toEqual(['openWebContent', 'gate open', 'fill', 'started'])
  })
})

describe('the end of a start', () => {
  it('fills the window once the tail has ended, and answers a second launch last', async () => {
    const log: string[] = []
    await endStart(startTail(steps(log)), filled(log), () => { log.push('started') })
    expect(log).toEqual(['afterWindow', 'mark afterWindowDone', 'report', 'stopOnCritical', 'openWebContent', 'fill', 'started'])
  })

  it('waits for a window that is made after the tail ended, and fills it then', async () => {
    const log: string[] = []
    let made: (window: { readonly fill: () => Promise<void> }) => void = () => {}
    const window = new Promise<{ readonly fill: () => Promise<void> }>((resolve) => { made = resolve })
    const ended = endStart(startTail(steps(log)), window, () => { log.push('started') })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(log).not.toContain('fill')
    expect(log).not.toContain('started')
    made({ fill: async () => { log.push('fill') } })
    await ended
    expect(log.slice(-2)).toEqual(['fill', 'started'])
  })

  it('fills nothing and lets no launch in when a failure is critical', async () => {
    const log: string[] = []
    const tail = startTail(steps(log, { afterWindow: async () => [failure(true)], stopOnCritical: () => true }))
    await endStart(tail, filled(log), () => { log.push('started') })
    expect(log).not.toContain('fill')
    expect(log).not.toContain('started')
  })

  it('marks the start whatever the fill does, so a second launch is never stranded', async () => {
    const log: string[] = []
    const window = Promise.resolve({ fill: async () => { throw new Error('restore failed') } })
    await expect(endStart(startTail(steps(log)), window, () => { log.push('started') })).rejects.toThrow('restore failed')
    expect(log.at(-1)).toBe('started')
  })

  it('lets a launch in when the window cannot be made', async () => {
    const log: string[] = []
    const tail = startTail(steps(log))
    await expect(endStart(tail, Promise.reject(new Error('no window')), () => { log.push('started') })).rejects.toThrow('no window')
    expect(log.at(-1)).toBe('started')
  })
})
