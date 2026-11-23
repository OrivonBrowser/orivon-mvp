import { describe, expect, it, vi } from 'vitest'
import type { Runtime } from '../../launch/start-launch.js'
import type { ShellServices } from '../../shell/shell-services.js'
import { launcherMenuInstaller } from '../install-launcher-menu.js'

const SOURCE = { execPath: '/opt/Orivon/orivon', appPath: '/x', packaged: true, appImage: undefined, env: {} }

type Item = { label: string, click: () => void }

/** Installs the menu for `platform`; `afterStart` is the call the start makes once the first window is filled. */
function run (platform: NodeJS.Platform, over: { profileId?: string, isPrivate?: boolean, kiosk?: boolean } = {}): {
  app: { setAppUserModelId: ReturnType<typeof vi.fn>, setUserTasks: ReturnType<typeof vi.fn>, dock: { setMenu: ReturnType<typeof vi.fn> } }
  items: () => Item[] | undefined
  services: { commands: { openWindow: ReturnType<typeof vi.fn> }, profiles: { openPrivate: ReturnType<typeof vi.fn> } }
  afterStart: () => void
} {
  const app = { setAppUserModelId: vi.fn(), setUserTasks: vi.fn(() => true), isPackaged: true, dock: { setMenu: vi.fn() } }
  const services = { kiosk: over.kiosk ?? false, commands: { openWindow: vi.fn() }, profiles: { openPrivate: vi.fn() } }
  let items: Item[] | undefined
  const installer = launcherMenuInstaller(platform, (built) => { items = built as never; return {} as never })
  const runtime = { profileId: over.profileId ?? 'default', isPrivate: over.isPrivate ?? false, source: SOURCE } as unknown as Runtime
  installer.install(app as never, services as unknown as ShellServices, {} as never, runtime)
  return { app, items: () => items, services, afterStart: () => { installer.afterStart?.(app as never, services as unknown as ShellServices, {} as never, runtime) } }
}

describe('the launcher menu', () => {
  it('sets the process id at install on Windows and the two jump list tasks only after the start', () => {
    const { app, afterStart } = run('win32')
    expect(app.setAppUserModelId).toHaveBeenCalledWith('com.orivonstack.orivon')
    expect(app.setUserTasks).not.toHaveBeenCalled()
    afterStart()
    expect(app.setUserTasks).toHaveBeenCalledTimes(1)
    const tasks = (app.setUserTasks.mock.calls[0] as unknown[])[0] as Array<{ title: string }>
    expect(tasks.map((task) => task.title)).toEqual(['New window', 'New private window'])
  })

  it('sets the dock menu on macOS only after the start, and its entries open a window and a private session', () => {
    const { app, items, services, afterStart } = run('darwin')
    expect(app.dock.setMenu).not.toHaveBeenCalled()
    afterStart()
    expect(app.dock.setMenu).toHaveBeenCalledTimes(1)
    expect(items()?.map((item) => item.label)).toEqual(['New Window', 'New Private Window'])
    items()?.[0]?.click()
    items()?.[1]?.click()
    expect(services.commands.openWindow).toHaveBeenCalledWith({})
    expect(services.profiles.openPrivate).toHaveBeenCalledTimes(1)
    expect(app.setAppUserModelId).not.toHaveBeenCalled()
  })

  it('sets nothing on Linux, where the desktop entry carries the actions', () => {
    const { app, afterStart } = run('linux')
    afterStart()
    expect(app.setAppUserModelId).not.toHaveBeenCalled()
    expect(app.setUserTasks).not.toHaveBeenCalled()
    expect(app.dock.setMenu).not.toHaveBeenCalled()
  })

  it('offers no entries from another profile, a private session or a kiosk, though the id is still set', () => {
    for (const over of [{ profileId: '0123456789ab' }, { isPrivate: true, profileId: 'private' }, { kiosk: true }]) {
      const windows = run('win32', over)
      windows.afterStart()
      expect(windows.app.setAppUserModelId).toHaveBeenCalledTimes(1)
      expect(windows.app.setUserTasks).not.toHaveBeenCalled()
      const mac = run('darwin', over)
      mac.afterStart()
      expect(mac.app.dock.setMenu).not.toHaveBeenCalled()
    }
  })
})
