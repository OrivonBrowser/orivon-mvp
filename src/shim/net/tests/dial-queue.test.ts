// In a file of its own: the dial queue is one per realm, and a test that leaves a dial hanging would
// hold one of its places for every test after it in the same file.
import { describe, expect, it } from 'vitest'
import { Socket, kDial, type NetDialFn } from '../socket.js'

describe('dials wait their turn', () => {
  it('a socket destroyed while its dial waited for room is never dialled', async () => {
    const pending: Array<() => void> = []
    let dials = 0
    const hanging: NetDialFn = async () => {
      dials += 1
      return await new Promise((resolve, reject) => { pending.push(() => { reject(new Error('gave up')) }); void resolve })
    }
    const busy = Array.from({ length: 64 }, () => {
      const socket = new Socket({ [kDial]: hanging })
      socket.on('error', () => {})
      return socket.connect({ host: 'example.com', port: 6881 })
    })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dials).toBe(64)
    const queued = new Socket({ [kDial]: hanging })
    queued.on('error', () => {})
    queued.connect({ host: 'example.com', port: 6882 })
    queued.destroy()
    for (const release of pending.splice(0)) release()
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(dials).toBe(64)
    for (const socket of busy) socket.destroy()
  })
})
