import { describe, expect, it, vi } from 'vitest'
import type { ChildProcess } from 'node:child_process'
import { peerCommand, spawnPeer } from '../peer-spawn.js'
import type { PeerSource } from '../peer-spawn.js'

const source = (overrides: Partial<PeerSource> = {}): PeerSource => ({
  execPath: '/opt/Orivon/orivon', appPath: '/repo/orivon', packaged: true, appImage: undefined,
  env: { HOME: '/home/person', DISPLAY: ':99', ELECTRON_RUN_AS_NODE: '1', ORIVON_INTRO: 'always', ORIVON_WINDOW_NO_FOCUS: '1' }, ...overrides
})

describe('peerCommand', () => {
  it('runs the packaged program with the flags', () => {
    expect(peerCommand(source(), ['--orivon-private'])).toMatchObject({ command: '/opt/Orivon/orivon', args: ['--orivon-private'] })
  })

  it('runs the AppImage itself, not the program inside the mount that goes away with it', () => {
    expect(peerCommand(source({ appImage: '/home/person/Orivon.AppImage' }), ['--orivon-profile=a1b2c3d4e5f6']).command).toBe('/home/person/Orivon.AppImage')
  })

  it('runs the app from source by naming the app to the Electron binary', () => {
    expect(peerCommand(source({ packaged: false, execPath: '/repo/node_modules/electron/dist/electron', appImage: '/ignored.AppImage' }), ['--orivon-private']))
      .toMatchObject({ command: '/repo/node_modules/electron/dist/electron', args: ['/repo/orivon', '--orivon-private'] })
  })

  it('hands on the environment except what would make the peer something else', () => {
    const { env } = peerCommand(source(), [])
    expect(env).toEqual({ HOME: '/home/person', DISPLAY: ':99' })
  })

  it('leaves the source environment as it was', () => {
    const s = source()
    peerCommand(s, [])
    expect(s.env['ELECTRON_RUN_AS_NODE']).toBe('1')
  })
})

describe('spawnPeer', () => {
  it('starts it detached, with no streams, and lets go of it', () => {
    const child = { unref: vi.fn() } as unknown as ChildProcess
    const spawn = vi.fn(() => child)
    expect(spawnPeer(source(), ['--orivon-private'], spawn as never)).toBe(child)
    expect(spawn).toHaveBeenCalledWith('/opt/Orivon/orivon', ['--orivon-private'], expect.objectContaining({ detached: true, stdio: 'ignore' }))
    expect(child.unref).toHaveBeenCalledTimes(1)
  })
})
