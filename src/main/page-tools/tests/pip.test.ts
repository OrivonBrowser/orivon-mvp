import { describe, expect, it, vi } from 'vitest'
import { ENTER_SCRIPT, EXIT_SCRIPT, togglePictureInPicture } from '../pip.js'
import type { PipFrame } from '../pip.js'

const frame = (answers: { exit?: unknown, enter?: unknown }): PipFrame & { executeJavaScript: ReturnType<typeof vi.fn> } => ({
  executeJavaScript: vi.fn(async (code: string) => {
    const answer = code === EXIT_SCRIPT ? answers.exit : answers.enter
    if (answer instanceof Error) throw answer
    return answer
  })
})

const page = (frames: PipFrame[], crashed = false): Parameters<typeof togglePictureInPicture>[0] => ({ mainFrame: { framesInSubtree: frames }, isCrashed: () => crashed })

describe('togglePictureInPicture', () => {
  it('runs both constant scripts with a user gesture', async () => {
    const only = frame({ exit: false, enter: true })
    await togglePictureInPicture(page([only]))
    expect(only.executeJavaScript).toHaveBeenCalledWith(EXIT_SCRIPT, true)
    expect(only.executeJavaScript).toHaveBeenCalledWith(ENTER_SCRIPT, true)
  })

  it('pops out the first video that can go', async () => {
    const a = frame({ exit: false, enter: false })
    const b = frame({ exit: false, enter: true })
    const c = frame({ exit: false, enter: true })
    expect(await togglePictureInPicture(page([a, b, c]))).toBe('entered')
    expect(c.executeJavaScript).not.toHaveBeenCalledWith(ENTER_SCRIPT, true)
  })

  it('puts a video back before it pops another out, wherever it is', async () => {
    const main = frame({ exit: false, enter: true })
    const inner = frame({ exit: true, enter: true })
    expect(await togglePictureInPicture(page([main, inner]))).toBe('exited')
    expect(main.executeJavaScript).not.toHaveBeenCalledWith(ENTER_SCRIPT, true)
    expect(inner.executeJavaScript).not.toHaveBeenCalledWith(ENTER_SCRIPT, true)
  })

  it('skips a frame that throws and goes on to the next', async () => {
    const broken = frame({ exit: new Error('detached'), enter: new Error('NotAllowedError') })
    const good = frame({ exit: false, enter: true })
    expect(await togglePictureInPicture(page([broken, good]))).toBe('entered')
  })

  it('answers none when no frame has a video, or the page is dead', async () => {
    expect(await togglePictureInPicture(page([frame({ exit: false, enter: false })]))).toBe('none')
    expect(await togglePictureInPicture(page([]))).toBe('none')
    const dead = frame({ enter: true })
    expect(await togglePictureInPicture(page([dead], true))).toBe('none')
    expect(dead.executeJavaScript).not.toHaveBeenCalled()
  })

  it('takes nothing from the page: the scripts are constants with no placeholders', () => {
    for (const script of [ENTER_SCRIPT, EXIT_SCRIPT]) expect(script).not.toMatch(/\$\{/)
  })
})
