import { describe, expect, it, vi } from 'vitest'
import { ElectronShimError } from '../errors.js'
import { createShell } from '../shell.js'

function setup (open: (url: string, target: string, features: string) => unknown = () => null) {
  const windowOpen = vi.fn(open)
  return { windowOpen, shell: createShell({ open: windowOpen }) }
}

const reasonOf = async (promise: Promise<unknown>): Promise<ElectronShimError> => {
  try {
    await promise
  } catch (error) {
    expect(error).toBeInstanceOf(ElectronShimError)
    return error as ElectronShimError
  }
  throw new Error('expected a rejection')
}

describe('shell.openExternal', () => {
  it('opens the URL in a new tab that cannot reach back to the app, and resolves undefined', async () => {
    const { shell, windowOpen } = setup()
    await expect(shell.openExternal('https://example.com/a?b=c')).resolves.toBeUndefined()
    expect(windowOpen).toHaveBeenCalledWith('https://example.com/a?b=c', '_blank', 'noopener,noreferrer')
  })

  it('hands a non-http scheme to the same call, so the browser\'s external-link question decides', async () => {
    const { shell, windowOpen } = setup()
    await shell.openExternal('magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567')
    expect(windowOpen).toHaveBeenCalledOnce()
  })

  it('accepts and ignores Electron\'s options', async () => {
    const { shell, windowOpen } = setup()
    await shell.openExternal('https://example.com/', { activate: false })
    expect(windowOpen).toHaveBeenCalledOnce()
  })

  it.each([undefined, null, 5, {}, ['https://example.com']])('rejects %s with invalid-usage and opens nothing', async (value) => {
    const { shell, windowOpen } = setup()
    const error = await reasonOf(shell.openExternal(value as never))
    expect(error.reason).toBe('invalid-usage')
    expect(error.api).toBe('shell.openExternal')
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it.each(['', 'not a url', '/relative/path', 'example.com'])('rejects the unparseable string %j with invalid-usage', async (value) => {
    const { shell, windowOpen } = setup()
    expect((await reasonOf(shell.openExternal(value))).reason).toBe('invalid-usage')
    expect(windowOpen).not.toHaveBeenCalled()
  })

  it('rejects, never throws synchronously, when the browser refuses window.open', async () => {
    const { shell } = setup(() => { throw new DOMException('blocked', 'SecurityError') })
    let promise: Promise<unknown> | undefined
    expect(() => { promise = shell.openExternal('https://example.com/') }).not.toThrow()
    await expect(promise).rejects.toBeInstanceOf(ElectronShimError)
  })

  it('returns a promise even for a bad argument', () => {
    const { shell } = setup()
    const result = shell.openExternal(1 as never)
    expect(result).toBeInstanceOf(Promise)
    return result.catch(() => {})
  })
})

describe('the rest of shell', () => {
  it.each(['openPath', 'showItemInFolder', 'trashItem', 'beep'])('%s refuses by name as a desktop-shell call', (member) => {
    const { shell } = setup()
    const each = shell as unknown as Record<string, () => unknown>
    expect(() => each[member]).not.toThrow()
    try {
      each[member]!()
      expect.unreachable()
    } catch (error) {
      expect(error).toBeInstanceOf(ElectronShimError)
      expect((error as ElectronShimError).reason).toBe('desktop-shell')
      expect((error as ElectronShimError).api).toBe(`shell.${member}`)
    }
  })

  it.each(['writeShortcutLink', 'readShortcutLink', 'somethingElse'])('%s refuses by name as unimplemented', (member) => {
    const { shell } = setup()
    const each = shell as unknown as Record<string, () => unknown>
    try {
      each[member]!()
      expect.unreachable()
    } catch (error) {
      expect((error as ElectronShimError).reason).toBe('unimplemented')
      expect((error as ElectronShimError).api).toBe(`shell.${member}`)
    }
  })
})
