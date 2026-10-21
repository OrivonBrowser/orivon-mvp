import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { headlessLaunch, NO_BUS, PRIVATE_BUS_CONFIG } from '../run-headless.mjs'
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
    expect(launch.env['DBUS_SESSION_BUS_ADDRESS']).toBe(NO_BUS)
    expect(launch.env['XDG_SESSION_TYPE']).toBe('x11')
    expect(launch.env['ORIVON_RUN_HEADLESS']).toBe('virtual')
  })

  // The desktop bus is how a file picker, a keyring prompt or a notification
  // reaches the real screen, whatever display the window is on.
  it('gives the command a bare session bus of its own by default, inside the virtual display', () => {
    const launch = headlessLaunch({ platform: 'linux', env: DESKTOP, has: having('xvfb-run', 'dbus-run-session'), command: 'npx', args: ['vitest'] })
    expect(launch).toMatchObject({ file: 'xvfb-run', args: ['-a', 'dbus-run-session', `--config-file=${PRIVATE_BUS_CONFIG}`, '--', 'npx', 'vitest'], privateBus: true })
    if (!('file' in launch)) throw new Error('refused')
    expect(launch.env['ORIVON_E2E_PRIVATE_BUS']).toBe('1')
    expect(launch.env['DBUS_SESSION_BUS_ADDRESS']).toBeUndefined()
    expect(launch.env['WAYLAND_DISPLAY']).toBeUndefined()
  })

  it('activates nothing on the private bus: its config names no service directory', () => {
    const config = readFileSync(PRIVATE_BUS_CONFIG, 'utf8')
    expect(config).toContain('<type>session</type>')
    expect(config).not.toMatch(/servicedir|standard_session_servicedirs|<include/)
  })

  it('points the command at a bus that does not exist when no private one can be started', () => {
    const launch = headlessLaunch({ platform: 'linux', env: DESKTOP, has: having('xvfb-run'), command: 'node', args: ['x.mjs'] })
    if (!('file' in launch)) throw new Error('refused')
    expect(launch.args).toEqual(['-a', 'node', 'x.mjs'])
    expect(launch.env['DBUS_SESSION_BUS_ADDRESS']).toBe(NO_BUS)
    expect(launch.env['ORIVON_E2E_PRIVATE_BUS']).toBeUndefined()
  })

  it('keeps the bus it has on CI, and the desktop bus for a run someone means to watch', () => {
    for (const env of [{ ...DESKTOP, CI: 'true' }, { ...DESKTOP, ORIVON_PRIVATE_BUS: '0' }]) {
      const launch = headlessLaunch({ platform: 'linux', env, has: having('xvfb-run', 'dbus-run-session'), command: 'node', args: ['x.mjs'] })
      if (!('file' in launch)) throw new Error('refused')
      expect(launch.args).toEqual(['-a', 'node', 'x.mjs'])
      expect(launch.env['DBUS_SESSION_BUS_ADDRESS']).toBe(DESKTOP.DBUS_SESSION_BUS_ADDRESS)
      expect(launch.env['ORIVON_E2E_PRIVATE_BUS']).toBeUndefined()
    }
  })

  it('gives CI the private bus too when ORIVON_PRIVATE_BUS=1 asks for it', () => {
    const launch = headlessLaunch({ platform: 'linux', env: { ...DESKTOP, CI: 'true', ORIVON_PRIVATE_BUS: '1' }, has: having('xvfb-run', 'dbus-run-session'), command: 'npx', args: ['vitest'] })
    expect(launch).toMatchObject({ args: ['-a', 'dbus-run-session', `--config-file=${PRIVATE_BUS_CONFIG}`, '--', 'npx', 'vitest'], privateBus: true })
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
