import { describe, expect, it } from 'vitest'
import { headlessLaunch } from '../run-headless.mjs'
import { visibleDesktopRefusal } from '../../test/support/launch-electron.mjs'

const DESKTOP = {
  PATH: '/usr/bin',
  WAYLAND_DISPLAY: 'wayland-0',
  XDG_SESSION_TYPE: 'wayland',
  DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus'
}

/** A machine with exactly these commands on PATH. */
const having = (...names: string[]) => (name: string): boolean => names.includes(name)

describe('headlessLaunch', () => {
  it('runs the command under xvfb-run, with Wayland stripped so Electron cannot find the real compositor', () => {
    const launch = headlessLaunch({ platform: 'linux', env: DESKTOP, has: having('xvfb-run'), command: 'npx', args: ['vitest', 'run'] })
    expect(launch).toMatchObject({ file: 'xvfb-run', args: ['-a', 'npx', 'vitest', 'run'], virtualDisplay: true, privateBus: false })
    if (!('file' in launch)) throw new Error('refused')
    expect(launch.env['WAYLAND_DISPLAY']).toBeUndefined()
    expect(launch.env['XDG_SESSION_TYPE']).toBe('x11')
    expect(launch.env['ORIVON_RUN_HEADLESS']).toBe('virtual')
  })

  // Not the default: the whole suite on a private bus would lose the
  // desktop keyring that safeStorage reads.
  it('keeps the desktop session bus unless a private one is asked for', () => {
    const launch = headlessLaunch({ platform: 'linux', env: DESKTOP, has: having('xvfb-run', 'dbus-run-session'), command: 'node', args: ['x.mjs'] })
    if (!('file' in launch)) throw new Error('refused')
    expect(launch.args).toEqual(['-a', 'node', 'x.mjs'])
    expect(launch.env['DBUS_SESSION_BUS_ADDRESS']).toBe(DESKTOP.DBUS_SESSION_BUS_ADDRESS)
    expect(launch.env['ORIVON_E2E_PRIVATE_BUS']).toBeUndefined()
  })

  // Inside xvfb-run, so the bus daemon and anything it starts inherit the
  // virtual display rather than the desktop's.
  it('gives the command a session bus of its own when ORIVON_PRIVATE_BUS=1, inside the virtual display, and says so', () => {
    const launch = headlessLaunch({ platform: 'linux', env: { ...DESKTOP, ORIVON_PRIVATE_BUS: '1' }, has: having('xvfb-run', 'dbus-run-session'), command: 'npx', args: ['vitest'] })
    expect(launch).toMatchObject({ file: 'xvfb-run', args: ['-a', 'dbus-run-session', '--', 'npx', 'vitest'], privateBus: true })
    if (!('file' in launch)) throw new Error('refused')
    expect(launch.env['ORIVON_E2E_PRIVATE_BUS']).toBe('1')
    expect(launch.env['DBUS_SESSION_BUS_ADDRESS']).toBeUndefined()
  })

  it('refuses rather than run on the desktop bus when a private one is asked for and cannot be had', () => {
    for (const has of [having('xvfb-run'), having('dbus-run-session'), having()]) {
      expect(headlessLaunch({ platform: 'linux', env: { ...DESKTOP, ORIVON_PRIVATE_BUS: '1' }, has, command: 'npx', args: [] })).toHaveProperty('refused')
    }
    expect(headlessLaunch({ platform: 'darwin', env: { ORIVON_PRIVATE_BUS: '1' }, has: having('xvfb-run', 'dbus-run-session'), command: 'npx', args: [] })).toHaveProperty('refused')
  })

  it('runs the command directly, environment untouched but for its mark, where there is no xvfb-run', () => {
    expect(headlessLaunch({ platform: 'darwin', env: DESKTOP, has: having(), command: 'npx', args: ['vitest'] }))
      .toEqual({ file: 'npx', args: ['vitest'], env: { ...DESKTOP, ORIVON_RUN_HEADLESS: 'direct' }, virtualDisplay: false, privateBus: false })
    expect(headlessLaunch({ platform: 'win32', env: {}, has: having(), command: 'npx', args: [] }))
      .toMatchObject({ file: 'npx' })
  })
})

// The other half of the mark: the shared launcher refuses a Linux desktop launch that skipped this file.
describe('visibleDesktopRefusal', () => {
  it('refuses a Linux launch that can reach the desktop and did not come through run-headless', () => {
    expect(visibleDesktopRefusal(DESKTOP, 'linux')).toMatch(/run-headless/)
    expect(visibleDesktopRefusal({ DISPLAY: ':0' }, 'linux')).toMatch(/run-headless/)
  })

  it('lets a run-headless child launch, with or without a virtual display, and a run someone means to watch', () => {
    for (const has of [having('xvfb-run'), having()]) {
      const launch = headlessLaunch({ platform: 'linux', env: DESKTOP, has, command: 'npx', args: [] })
      if (!('file' in launch)) throw new Error('refused')
      expect(visibleDesktopRefusal(launch.env, 'linux')).toBeUndefined()
    }
    expect(visibleDesktopRefusal({ ...DESKTOP, ORIVON_ALLOW_VISIBLE_WINDOW: '1' }, 'linux')).toBeUndefined()
  })

  it('leaves alone a machine with no display, and every other platform', () => {
    expect(visibleDesktopRefusal({ PATH: '/usr/bin' }, 'linux')).toBeUndefined()
    expect(visibleDesktopRefusal(DESKTOP, 'darwin')).toBeUndefined()
    expect(visibleDesktopRefusal(DESKTOP, 'win32')).toBeUndefined()
  })
})
