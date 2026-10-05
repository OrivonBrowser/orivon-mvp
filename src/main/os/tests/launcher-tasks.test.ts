import { describe, expect, it } from 'vitest'
import type { PeerSource } from '../../launch/peer-spawn.js'
import { appUserModelId, launcherTasks, relaunchCommand } from '../launcher-tasks.js'

const packaged: PeerSource = { execPath: 'C:\\Program Files\\Orivon\\Orivon.exe', appPath: 'C:\\Program Files\\Orivon\\resources\\app.asar', packaged: true, appImage: undefined, env: {} }
const source: PeerSource = { execPath: 'C:\\dev\\node_modules\\electron\\dist\\electron.exe', appPath: 'C:\\My Projects\\orivon', packaged: false, appImage: undefined, env: {} }

describe('the launcher tasks', () => {
  it('start the installed program with the flag and nothing else', () => {
    expect(launcherTasks(packaged)).toEqual([
      expect.objectContaining({ title: 'New window', program: packaged.execPath, arguments: '"--new-window"', iconPath: packaged.execPath, iconIndex: 0 }),
      expect.objectContaining({ title: 'New private window', program: packaged.execPath, arguments: '"--new-private-window"' })
    ])
  })

  it('start a run from source with the app path before the flag, and quote a path with spaces', () => {
    const [window, privateWindow] = launcherTasks(source)
    expect(window?.program).toBe(source.execPath)
    expect(window?.arguments).toBe('"C:\\My Projects\\orivon" "--new-window"')
    expect(privateWindow?.arguments).toBe('"C:\\My Projects\\orivon" "--new-private-window"')
  })

  it('start an AppImage by its own file, with the flag', () => {
    const [window] = launcherTasks({ ...packaged, execPath: '/tmp/.mount_x/orivon', appImage: '/home/p/Orivon.AppImage' })
    expect(window?.program).toBe('/home/p/Orivon.AppImage')
    expect(window?.arguments).toBe('"--new-window"')
  })

  it('never carry a switch of the running launch into a command the system holds', () => {
    const inherited = { ...source, env: { ORIVON_PROFILE: 'x' } }
    for (const task of launcherTasks(inherited)) {
      expect(task.arguments).not.toContain('--user-data-dir')
      expect(task.arguments).not.toContain('--no-sandbox')
    }
  })

  it('refuse a path the command line cannot quote', () => {
    expect(() => launcherTasks({ ...source, appPath: 'C:\\a"b' })).toThrow()
  })
})

describe('the relaunch command of a window', () => {
  it('is the program and what it needs to start, quoted, with no flag', () => {
    expect(relaunchCommand(source)).toBe('"C:\\dev\\node_modules\\electron\\dist\\electron.exe" "C:\\My Projects\\orivon"')
    expect(relaunchCommand(packaged)).toBe('"C:\\Program Files\\Orivon\\Orivon.exe"')
  })
})

describe('the app user model id', () => {
  it('is the builder\'s app id for an installed program and its own for a run from source', () => {
    expect(appUserModelId(true)).toBe('com.orivonstack.orivon')
    expect(appUserModelId(false)).toBe('com.orivonstack.orivon.source')
  })
})
