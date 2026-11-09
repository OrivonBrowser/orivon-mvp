// The commands that make a real pointer press, built for each system without making one.
import { describe, expect, it } from 'vitest'
import { pointerCommand, realPointerAvailable } from './native-pointer.js'
import { underVirtualDisplay } from './focus-helpers.js'

const decoded = (args: string[]): string => Buffer.from(args[args.indexOf('-EncodedCommand') + 1] ?? '', 'base64').toString('utf16le')

describe('realPointerAvailable', () => {
  it('is true on Windows and macOS only on a hosted runner, whose desktop belongs to the job', () => {
    for (const platform of ['win32', 'darwin']) {
      expect(realPointerAvailable(platform, { GITHUB_ACTIONS: 'true' })).toBe(true)
      expect(realPointerAvailable(platform, { CI: 'true' })).toBe(false)
      expect(realPointerAvailable(platform, {})).toBe(false)
    }
  })

  it('follows the virtual display on Linux, whatever the environment says', () => {
    expect(realPointerAvailable('linux', { GITHUB_ACTIONS: 'true' })).toBe(underVirtualDisplay())
  })

  it('is false on a system with no way to press', () => {
    expect(realPointerAvailable('freebsd', { GITHUB_ACTIONS: 'true' })).toBe(false)
  })
})

describe('pointerCommand', () => {
  it('moves the Windows pointer in physical pixels, then presses and releases the left button', () => {
    const { file, args } = pointerCommand('win32', 120.4, 64.6, 1)
    expect(file).toBe('powershell.exe')
    const script = decoded(args)
    expect(script.indexOf('SetProcessDPIAware()')).toBeGreaterThan(-1)
    expect(script.indexOf('SetProcessDPIAware()')).toBeLessThan(script.indexOf('SetCursorPos(120, 65)'))
    expect(script).toContain('mouse_event(2, 0, 0, 0, [UIntPtr]::Zero)')
    expect(script).toContain('mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)')
    expect(script.indexOf('mouse_event(2,')).toBeLessThan(script.indexOf('mouse_event(4,'))
  })

  it('picks the Windows button flags of the middle and right buttons', () => {
    expect(decoded(pointerCommand('win32', 1, 1, 2).args)).toContain('mouse_event(32,')
    expect(decoded(pointerCommand('win32', 1, 1, 2).args)).toContain('mouse_event(64,')
    expect(decoded(pointerCommand('win32', 1, 1, 3).args)).toContain('mouse_event(8,')
    expect(decoded(pointerCommand('win32', 1, 1, 3).args)).toContain('mouse_event(16,')
  })

  it('posts macOS events for a move, a press and a release at the point', () => {
    const { file, args } = pointerCommand('darwin', 300, 410, 1)
    expect(file).toBe('osascript')
    expect(args.slice(0, 2)).toEqual(['-l', 'JavaScript'])
    const script = args.filter((_, index) => index > 1 && args[index - 1] === '-e').join('\n')
    expect(script).toContain('{ x: 300, y: 410 }, 0)')
    expect(script).toContain('post($.kCGEventMouseMoved)')
    expect(script.indexOf('post(1)')).toBeLessThan(script.indexOf('post(2)'))
  })

  it('sends the X11 events through python on Linux, with the point and the button as arguments', () => {
    const { file, args } = pointerCommand('linux', 10, 20, 3)
    expect(file).toBe('python3')
    expect(args.slice(2)).toEqual(['10', '20', '3'])
    expect(args[1]).toContain('XTestFakeButtonEvent')
  })
})
