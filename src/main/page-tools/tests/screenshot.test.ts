import { describe, expect, it, vi } from 'vitest'
import { captureFullPage, captureVisible, fullPageAvailable, fullPageClip, MAX_FULL_PAGE_PIXELS } from '../screenshot.js'
import type { CaptureContents } from '../screenshot.js'

const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47])
const wait = async (): Promise<void> => {}

type Commands = Record<string, unknown | Error>

function contents (commands: Commands = {}, extra: Partial<CaptureContents> = {}): CaptureContents & { calls: Array<[string, unknown]>, debugger: { attach: ReturnType<typeof vi.fn>, detach: ReturnType<typeof vi.fn> } } {
  const calls: Array<[string, unknown]> = []
  const table: Commands = {
    'Page.getLayoutMetrics': { cssContentSize: { width: 1280, height: 3000 } },
    'Runtime.evaluate': { result: { value: 1 } },
    'Page.captureScreenshot': { data: Buffer.from(png).toString('base64') },
    ...commands
  }
  return {
    calls,
    capturePage: async () => ({ toPNG: () => png, isEmpty: () => false }),
    isDevToolsOpened: () => false,
    isCrashed: () => false,
    debugger: {
      attach: vi.fn(),
      detach: vi.fn(),
      isAttached: () => false,
      sendCommand: async (method: string, params?: unknown) => {
        calls.push([method, params])
        const answer = table[method]
        if (answer instanceof Error) throw answer
        return answer
      }
    },
    ...extra
  } as never
}

describe('fullPageClip', () => {
  it('takes the whole page when it fits', () => {
    expect(fullPageClip({ width: 1280, height: 3000.4 }, 1)).toEqual({ width: 1280, height: 3001, truncated: false })
  })

  it('cuts at 16,384 device pixels, so a denser screen cuts sooner', () => {
    expect(fullPageClip({ width: 800, height: 40_000 }, 1)).toEqual({ width: 800, height: MAX_FULL_PAGE_PIXELS, truncated: true })
    expect(fullPageClip({ width: 800, height: 40_000 }, 2)).toEqual({ width: 800, height: MAX_FULL_PAGE_PIXELS / 2, truncated: true })
    expect(fullPageClip({ width: 800, height: 8192 }, 2).truncated).toBe(false)
  })

  it('treats a missing or absurd density as 1', () => {
    expect(fullPageClip({ width: 10, height: 10 }, Number.NaN)).toMatchObject({ height: 10 })
    expect(fullPageClip({ width: 10, height: 10 }, 0)).toMatchObject({ height: 10 })
  })
})

describe('fullPageAvailable', () => {
  it('is false while developer tools are open, and on a crashed page', () => {
    expect(fullPageAvailable({ isDevToolsOpened: () => true, isCrashed: () => false })).toBe(false)
    expect(fullPageAvailable({ isDevToolsOpened: () => false, isCrashed: () => true })).toBe(false)
    expect(fullPageAvailable({ isDevToolsOpened: () => false, isCrashed: () => false })).toBe(true)
  })
})

describe('captureFullPage', () => {
  it('captures beyond the viewport at the page\'s full size and detaches', async () => {
    const wc = contents()
    const shot = await captureFullPage(wc)
    expect(Buffer.from(shot.png)).toEqual(Buffer.from(png))
    expect(shot.truncated).toBe(false)
    expect(wc.calls.at(-1)).toEqual(['Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: 1280, height: 3000, scale: 1 } }])
    expect(wc.debugger.attach).toHaveBeenCalledWith('1.3')
    expect(wc.debugger.detach).toHaveBeenCalledTimes(1)
  })

  it('reports a cut page', async () => {
    const wc = contents({ 'Page.getLayoutMetrics': { cssContentSize: { width: 800, height: 50_000 } } })
    const shot = await captureFullPage(wc)
    expect(shot.truncated).toBe(true)
    expect(wc.calls.at(-1)?.[1]).toMatchObject({ clip: { height: MAX_FULL_PAGE_PIXELS } })
  })

  it('detaches when a command fails', async () => {
    const wc = contents({ 'Page.captureScreenshot': new Error('no frame') })
    await expect(captureFullPage(wc)).rejects.toThrow('no frame')
    expect(wc.debugger.detach).toHaveBeenCalledTimes(1)
  })

  it('detaches when the page reports no size or an empty picture', async () => {
    const noSize = contents({ 'Page.getLayoutMetrics': {} })
    await expect(captureFullPage(noSize)).rejects.toThrow('no size')
    expect(noSize.debugger.detach).toHaveBeenCalledTimes(1)
    const empty = contents({ 'Page.captureScreenshot': { data: '' } })
    await expect(captureFullPage(empty)).rejects.toThrow('empty')
    expect(empty.debugger.detach).toHaveBeenCalledTimes(1)
  })

  it('reports an attach that throws and never detaches a claim that is not its own', async () => {
    const wc = contents()
    wc.debugger.attach.mockImplementation(() => { throw new Error('Another debugger is already attached') })
    await expect(captureFullPage(wc)).rejects.toThrow('already attached')
    expect(wc.debugger.detach).not.toHaveBeenCalled()
  })

  it('refuses without attaching while developer tools are open', async () => {
    const wc = contents({}, { isDevToolsOpened: () => true })
    await expect(captureFullPage(wc)).rejects.toThrow('developer tools')
    expect(wc.debugger.attach).not.toHaveBeenCalled()
  })

  it('survives a detach that throws', async () => {
    const wc = contents()
    wc.debugger.detach.mockImplementation(() => { throw new Error('gone') })
    await expect(captureFullPage(wc)).resolves.toBeDefined()
  })
})

describe('captureVisible', () => {
  it('returns the picture of the contents', async () => {
    const shot = await captureVisible(contents(), wait)
    expect(shot).toEqual({ png, truncated: false })
  })

  it('asks again when the first frame is not ready, up to three times', async () => {
    let tries = 0
    const wc = contents({}, { capturePage: async () => { tries++; if (tries < 3) throw new Error('UnknownVizError'); return { toPNG: () => png, isEmpty: () => false } } })
    await expect(captureVisible(wc, wait)).resolves.toMatchObject({ png })
    expect(tries).toBe(3)
  })

  it('gives up with the last failure, and treats an empty picture as one', async () => {
    const failing = contents({}, { capturePage: async () => { throw new Error('UnknownVizError') } })
    await expect(captureVisible(failing, wait)).rejects.toThrow('UnknownVizError')
    const empty = contents({}, { capturePage: async () => ({ toPNG: () => png, isEmpty: () => true }) })
    await expect(captureVisible(empty, wait)).rejects.toThrow('empty')
  })
})
