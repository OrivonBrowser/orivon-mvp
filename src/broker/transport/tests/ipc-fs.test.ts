import { describe, expect, it } from 'vitest'
import { handleControlRequest } from '../ipc.js'
import { APP, type BrokerCall, envelope, frameFor, stubBroker } from './ipc.test-helpers.js'

// `orivon.fs`'s eight dispatch cases (readFile, writeFile, confineSync has
// no control-channel method of its own -- ADR-0016's own sync-fs.ts channel
// -- plus queue item 2.1's mkdir/readdir/stat/rm/rename), split out of
// ipc.test.ts under code-guidelines.md's 800-line test limit, matching
// ./ipc-udp.test.ts's own precedent for a whole control method outgrowing
// that file. A pure move for fs.readFile/fs.writeFile: no behaviour
// changed, so the diff reads as one.
//
// THIS FILE PROVES DISPATCH ONLY -- that ipc.ts's `dispatch()` validates the
// payload shape and calls the right `broker.fs.*` method with the right
// arguments. Confinement itself (does the path actually stay inside the
// app's root) is index-fs-extended.test.ts's job, against the real
// createBroker/fs-capability.ts stack; a stubBroker here has no path
// confinement to get wrong.

describe('the fs control operations', () => {
  it('fs.readFile passes path through and returns the bytes', async () => {
    const calls: BrokerCall[] = []
    const bytes = new Uint8Array([9, 8, 7])
    const broker = stubBroker(calls, { readFile: async () => bytes })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('fs.readFile', { path: '/a/b.txt' }))

    expect(response).toEqual({ id: 'req-1', ok: true, result: bytes })
    expect(calls).toEqual([{ method: 'fs.readFile', origin: APP, args: '/a/b.txt' }])
  })

  it('fs.writeFile passes path and data through and resolves undefined', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { writeFile: async () => {} })
    const data = new Uint8Array([1, 2, 3])

    const response = await handleControlRequest(broker, frameFor(APP), envelope('fs.writeFile', { path: '/a/b.txt', data }))

    expect(response).toEqual({ id: 'req-1', ok: true, result: undefined })
    expect(calls).toEqual([{ method: 'fs.writeFile', origin: APP, args: { path: '/a/b.txt', data } }])
  })

  it('fs.mkdir passes path and recursive through and resolves undefined', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { mkdir: async () => {} })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('fs.mkdir', { path: '/a/b', recursive: true }))

    expect(response).toEqual({ id: 'req-1', ok: true, result: undefined })
    expect(calls).toEqual([{ method: 'fs.mkdir', origin: APP, args: { path: '/a/b', opts: { recursive: true } } }])
  })

  it('fs.mkdir works with no recursive flag at all', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { mkdir: async () => {} })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('fs.mkdir', { path: '/a' }))

    expect(response).toEqual({ id: 'req-1', ok: true, result: undefined })
    expect(calls).toEqual([{ method: 'fs.mkdir', origin: APP, args: { path: '/a', opts: undefined } }])
  })

  it('fs.readdir passes the path through and returns the entry names', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { readdir: async () => ['a.txt', 'sub'] })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('fs.readdir', { path: '/a' }))

    expect(response).toEqual({ id: 'req-1', ok: true, result: ['a.txt', 'sub'] })
    expect(calls).toEqual([{ method: 'fs.readdir', origin: APP, args: '/a' }])
  })

  it('fs.stat passes the path through and returns the stat result', async () => {
    const calls: BrokerCall[] = []
    const stat = { size: 3, isFile: true, isDirectory: false, mtimeMs: 123 }
    const broker = stubBroker(calls, { stat: async () => stat })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('fs.stat', { path: '/a/b.txt' }))

    expect(response).toEqual({ id: 'req-1', ok: true, result: stat })
    expect(calls).toEqual([{ method: 'fs.stat', origin: APP, args: '/a/b.txt' }])
  })

  it('fs.rm passes path and recursive through and resolves undefined', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { rm: async () => {} })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('fs.rm', { path: '/a', recursive: true }))

    expect(response).toEqual({ id: 'req-1', ok: true, result: undefined })
    expect(calls).toEqual([{ method: 'fs.rm', origin: APP, args: { path: '/a', opts: { recursive: true } } }])
  })

  it('fs.rename passes from and to through and resolves undefined', async () => {
    const calls: BrokerCall[] = []
    const broker = stubBroker(calls, { rename: async () => {} })

    const response = await handleControlRequest(broker, frameFor(APP), envelope('fs.rename', { from: '/a', to: '/b' }))

    expect(response).toEqual({ id: 'req-1', ok: true, result: undefined })
    expect(calls).toEqual([{ method: 'fs.rename', origin: APP, args: { from: '/a', to: '/b' } }])
  })
})

describe('fs control operations reject a malformed payload as invalid, without calling the broker', () => {
  it.each<[string, unknown]>([
    ['fs.readFile', {}],
    ['fs.readFile', { path: 42 }],
    ['fs.writeFile', { path: '/a' }],
    ['fs.writeFile', { path: '/a', data: 'not bytes' }],
    ['fs.mkdir', {}],
    ['fs.mkdir', { path: 42 }],
    ['fs.mkdir', { path: '/a', recursive: 'yes' }],
    ['fs.readdir', {}],
    ['fs.readdir', { path: 42 }],
    ['fs.stat', {}],
    ['fs.stat', { path: 42 }],
    ['fs.rm', {}],
    ['fs.rm', { path: 42 }],
    ['fs.rm', { path: '/a', recursive: 'yes' }],
    ['fs.rename', {}],
    ['fs.rename', { from: '/a' }],
    ['fs.rename', { to: '/b' }],
    ['fs.rename', { from: 42, to: '/b' }],
    ['fs.rename', { from: '/a', to: 42 }]
  ])('%s rejects a malformed payload as invalid, without calling the broker', async (method, payload) => {
    const calls: BrokerCall[] = []
    const response = await handleControlRequest(stubBroker(calls), frameFor(APP), envelope(method, payload))
    expect(response).toMatchObject({ ok: false, code: 'invalid' })
    expect(calls).toEqual([])
  })
})
