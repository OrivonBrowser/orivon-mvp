import { describe, expect, it, vi } from 'vitest'
import { paintWhileHidden } from '../hidden-paint.js'
import type { PaintTarget } from '../hidden-paint.js'

function fakeContents (options: { attach?: () => void, destroyed?: boolean } = {}): { contents: PaintTarget, calls: string[], settle: () => void } {
  const calls: string[] = []
  const pending: Array<() => void> = []
  const contents = {
    isDestroyed: () => options.destroyed === true,
    debugger: {
      attach: (version?: string) => { options.attach?.(); calls.push(`attach ${version ?? ''}`) },
      detach: () => { calls.push('detach') },
      sendCommand: async (method: string, params?: object) => {
        calls.push(`${method} ${JSON.stringify(params)}`)
        await new Promise<void>((resolve) => { pending.push(resolve) })
        return {}
      }
    }
  } as unknown as PaintTarget
  return { contents, calls, settle: () => { for (const resolve of pending.splice(0)) resolve() } }
}

const flush = async (): Promise<void> => { await new Promise((resolve) => setImmediate(resolve)) }

describe('paintWhileHidden', () => {
  it('attaches and turns focus emulation on, which is what makes the hidden page visible', () => {
    const { contents, calls } = fakeContents()
    paintWhileHidden(contents)
    expect(calls).toEqual(['attach 1.3', 'Emulation.setFocusEmulationEnabled {"enabled":true}'])
  })

  it('turns the emulation off and detaches once it is released, and not before the command is answered', async () => {
    const { contents, calls, settle } = fakeContents()
    const release = paintWhileHidden(contents)
    settle()
    await flush()
    release()
    expect(calls.slice(2)).toEqual(['Emulation.setFocusEmulationEnabled {"enabled":false}'])
    settle()
    await flush()
    expect(calls.slice(2)).toEqual(['Emulation.setFocusEmulationEnabled {"enabled":false}', 'detach'])
  })

  it('releases once however many times it is asked', async () => {
    const { contents, calls, settle } = fakeContents()
    const release = paintWhileHidden(contents)
    release()
    release()
    settle()
    await flush()
    settle()
    await flush()
    expect(calls.filter((call) => call === 'detach')).toHaveLength(1)
    expect(calls.filter((call) => call.endsWith('{"enabled":false}'))).toHaveLength(1)
  })

  it('leaves a page whose debugger another client holds alone, and its release does nothing', () => {
    const attach = vi.fn(() => { throw new Error('Another debugger is already attached to the WebContents.') })
    const { contents, calls } = fakeContents({ attach })
    const release = paintWhileHidden(contents)
    release()
    expect(attach).toHaveBeenCalledTimes(1)
    expect(calls).toEqual([])
  })

  it('does not touch a page that is gone when it is released', () => {
    const state = { destroyed: false }
    const { contents, calls } = fakeContents()
    const gone = { ...contents, isDestroyed: () => state.destroyed } as PaintTarget
    const release = paintWhileHidden(gone)
    state.destroyed = true
    release()
    expect(calls).toEqual(['attach 1.3', 'Emulation.setFocusEmulationEnabled {"enabled":true}'])
  })

  it('never rejects when the page refuses a command', async () => {
    const calls: string[] = []
    const contents = {
      isDestroyed: () => false,
      debugger: {
        attach: () => { calls.push('attach') },
        detach: () => { calls.push('detach') },
        sendCommand: () => Promise.reject(new Error('Target closed'))
      }
    } as unknown as PaintTarget
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    try {
      paintWhileHidden(contents)()
      await flush()
      await flush()
      expect(unhandled).not.toHaveBeenCalled()
      expect(calls).toEqual(['attach', 'detach'])
    } finally {
      process.off('unhandledRejection', unhandled)
    }
  })
})
