import { describe, expect, it, vi } from 'vitest'
import type { PeerSource } from '../../launch/peer-spawn.js'
import type { WindowContext } from '../../shell/window-context.js'
import { windowsTaskbarHook } from '../windows-taskbar.js'

const source: PeerSource = { execPath: 'C:\\dev\\electron.exe', appPath: 'C:\\My Projects\\orivon', packaged: false, appImage: undefined, env: {} }

function opened (platform: NodeJS.Platform, from: PeerSource): ReturnType<typeof vi.fn> {
  const setAppDetails = vi.fn()
  const hook = windowsTaskbarHook(() => ({ platform, source: from }))
  hook.opened?.({ window: { window: { setAppDetails } } } as unknown as WindowContext, {})
  return setAppDetails
}

describe('the taskbar button of a run from source on Windows', () => {
  it('relaunches the program with the app path, under the source id', () => {
    expect(opened('win32', source)).toHaveBeenCalledWith({
      appId: 'com.orivonstack.orivon.source',
      relaunchCommand: '"C:\\dev\\electron.exe" "C:\\My Projects\\orivon"',
      relaunchDisplayName: 'Orivon',
      appIconPath: source.execPath
    })
  })

  it('is left to the installer for an installed program', () => {
    expect(opened('win32', { ...source, packaged: true })).not.toHaveBeenCalled()
  })

  it('does nothing on another platform', () => {
    expect(opened('linux', source)).not.toHaveBeenCalled()
    expect(opened('darwin', source)).not.toHaveBeenCalled()
  })
})
