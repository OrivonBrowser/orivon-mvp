import { afterEach, describe, expect, it, vi } from 'vitest'
import { createFakeUdpSocket } from './support/fake-udp-socket.js'
import type { Orivon } from '../../contracts/capability-api.js'

type GlobalWithOrivon = typeof globalThis & { orivon?: Orivon }

function installFakeOrivon (): { udpBindCalls: Array<{ port: number }> } {
  const udpBindCalls: Array<{ port: number }> = []
  const fake = createFakeUdpSocket()
  ;(globalThis as GlobalWithOrivon).orivon = {
    net: {
      connect: async () => { throw new Error('not used') },
      connectSecure: async () => { throw new Error('not used') },
      listen: async () => { throw new Error('not used') },
      udpBind: async (opts: { port: number }) => { udpBindCalls.push(opts); return fake.socket }
    }
  } as unknown as Orivon
  return { udpBindCalls }
}

afterEach(() => {
  delete (globalThis as GlobalWithOrivon).orivon
  vi.resetModules()
})

describe('node-dgram.ts', () => {
  it('createSocket("udp4") accepts the type argument for shape compatibility and binds through orivon.net.udpBind', async () => {
    const { udpBindCalls } = installFakeOrivon()
    const dgram = await import('../node-dgram.js')
    const socket = dgram.createSocket('udp4')
    socket.bind(6881)
    await vi.waitFor(() => expect(udpBindCalls).toHaveLength(1))
    expect(udpBindCalls[0]).toEqual({ port: 6881 })
  })

  it('createSocket accepts an optional message listener, matching real Node', async () => {
    installFakeOrivon()
    const dgram = await import('../node-dgram.js')
    const onMessage = vi.fn()
    const socket = dgram.createSocket('udp4', onMessage)
    expect(socket.listenerCount('message')).toBe(1)
  })

  it('surfaces a clear, named "error" event if window.orivon is absent when bind is attempted', async () => {
    const dgram = await import('../node-dgram.js')
    const socket = dgram.createSocket('udp4')
    const error = new Promise<Error>((resolve) => socket.once('error', resolve))
    socket.bind(0)
    expect((await error).message).toMatch(/window\.orivon/)
  })
})
