import { describe, expect, it, vi } from 'vitest'
import type { Runtime } from '../../launch/start-launch.js'
import type { ShellServices } from '../../shell/shell-services.js'
import { launcherMenuInstaller } from '../install-launcher-menu.js'

const SOURCE = { execPath: '/opt/Orivon/orivon', appPath: '/x', packaged: true, appImage: undefined, env: {} }

function run (platform: NodeJS.Platform, over: { profileId?: string, isPrivate?: boolean, kiosk?: boolean } = {}): { app: Record<string, ReturnType<typeof vi.fn>>, items: Array<{ label: string, click: () => void }> | undefined, services: { commands: { openWindow: ReturnType<typeof vi.fn> }, profiles: { openPrivate: ReturnType<typeof vi.fn> } } } {
  const dock = { setMenu: vi.fn() }
  const app = { setAppUserModelId: vi.fn(), setUserTasks: vi.fn(() => true), isPackaged: true, dock }
  const services = { kiosk: over.kiosk ?? false, commands: { openWindow: vi.fn() }, profiles: { openPrivate: vi.fn() } }
  let items: Array<{ label: string, click: () => void }> | undefined
  const installer = launcherMenuInstaller(platform, (built) => { items = built as never; return {} as never })
  installer.install(app as never, services as unknown as ShellServices, {} as never, { profileId: over.profileId ?? 'default', isPrivate: over.isPrivate ?? false, source: SOURCE } as unknown as Runtime)
  return { app: { ...app, setMenu: dock.setMenu } as never, items, services }
}

describe('the launcher menu', () => {
  it('sets the process id and the two jump list tasks on Windows', () => {
    const { app } = run('win32')
    expect(app['setAppUserModelId']).toHaveBeenCalledWith('com.orivonstack.orivon')
    expect(app['setUserTasks']).toHaveBeenCalledTimes(1)
    const tasks = (app['setUserTasks']?.mock.calls[0] as unknown[])[0] as Array<{ title: string }>
    expect(tasks.map((task) => task.title)).toEqual(['New window', 'New private window'])
  })

  it('sets the dock menu on macOS, and its entries open a window and a private session', () => {
    const { app, items, services } = run('darwin')
    expect(app['setMenu']).toHaveBeenCalledTimes(1)
    expect(items?.map((item) => item.label)).toEqual(['New Window', 'New Private Window'])
    items?.[0]?.click()
    items?.[1]?.click()
    expect(services.commands.openWindow).toHaveBeenCalledWith({})
    expect(services.profiles.openPrivate).toHaveBeenCalledTimes(1)
    expect(app['setAppUserModelId']).not.toHaveBeenCalled()
  })

  it('sets nothing on Linux, where the desktop entry carries the actions', () => {
    const { app } = run('linux')
    expect(app['setAppUserModelId']).not.toHaveBeenCalled()
    expect(app['setUserTasks']).not.toHaveBeenCalled()
    expect(app['setMenu']).not.toHaveBeenCalled()
  })

  it('offers no entries from another profile, a private session or a kiosk, though the id is still set', () => {
    for (const over of [{ profileId: '0123456789ab' }, { isPrivate: true, profileId: 'private' }, { kiosk: true }]) {
      const { app } = run('win32', over)
      expect(app['setAppUserModelId']).toHaveBeenCalledTimes(1)
      expect(app['setUserTasks']).not.toHaveBeenCalled()
      const mac = run('darwin', over)
      expect(mac.app['setMenu']).not.toHaveBeenCalled()
    }
  })
})
