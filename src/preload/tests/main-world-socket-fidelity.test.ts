// installOrivon's TcpSocket at the edges a page reaches without meaning to:
// cancelling its readable, never touching `closed`, and reading the errno a
// peer reset carries. Kept apart from main-world-socket.test.ts, which
// covers the ordinary lifecycle.
import { afterEach, describe, expect, it } from 'vitest'
import { installOrivon } from '../main-world-socket.js'
import { LIMITS, fakeBridge, fakeSocketBridgeResult, tick } from './main-world-socket.test-helpers.js'

interface PageSocket {
  readable: ReadableStream<Uint8Array>
  closed: Promise<void>
}

async function connect (result: ReturnType<typeof fakeSocketBridgeResult>): Promise<PageSocket> {
  const target: Record<string, unknown> = {}
  installOrivon(fakeBridge(result), LIMITS, target)
  const orivon = target.orivon as { net: { connect: (opts: unknown) => Promise<PageSocket> } }
  return await orivon.net.connect({ host: 'x.example', port: 443 })
}

const unhandled: unknown[] = []
function onUnhandled (reason: unknown): void { unhandled.push(reason) }

afterEach(() => {
  process.off('unhandledRejection', onUnhandled)
  unhandled.length = 0
})

describe('installOrivon -- a cancelled readable', () => {
  it('discards later data without throwing, and still credits it so the peer is not stalled', async () => {
    const result = fakeSocketBridgeResult()
    const socket = await connect(result)

    await socket.readable.cancel()

    expect(() => { result.emitData(new Uint8Array(7)) }).not.toThrow()
    expect(result.reportConsumedCalls).toEqual([7])
    expect(() => { result.emitReadEnd() }).not.toThrow()
  })
})

describe('installOrivon -- `closed` the page never touches', () => {
  it('raises no unhandled rejection on an abrupt close, while a page that does listen still sees it', async () => {
    process.on('unhandledRejection', onUnhandled)
    let fail: (error: unknown) => void = () => {}
    const result = Object.assign(fakeSocketBridgeResult(), { closed: new Promise<void>((_resolve, reject) => { fail = reject }) })
    const ignored = await connect(result)
    void ignored

    fail({ name: 'OrivonError', message: 'orivon: reset', code: 'reset' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(unhandled).toEqual([])

    await expect(ignored.closed).rejects.toMatchObject({ code: 'reset' })
  })
})

describe('installOrivon -- a peer reset', () => {
  it('errors the readable with the platform code the broker sent', async () => {
    const result = fakeSocketBridgeResult()
    const socket = await connect(result)

    result.emitReadEnd('reset', 'ECONNRESET')
    await tick()

    await expect(socket.readable.getReader().read()).rejects.toMatchObject({ code: 'reset', platformCode: 'ECONNRESET' })
  })
})

describe('installOrivon -- a revived rejection', () => {
  it('keeps the handleId the isolated world attached', async () => {
    const bridge = fakeBridge(fakeSocketBridgeResult())
    bridge.appManifest = async () => { throw { name: 'OrivonError', message: 'orivon: closed', code: 'closed', handleId: 'h9' } }
    const target: Record<string, unknown> = {}
    installOrivon(bridge, LIMITS, target)
    const orivon = target.orivon as { app: { manifest: () => Promise<unknown> } }

    await expect(orivon.app.manifest()).rejects.toMatchObject({ code: 'closed', handleId: 'h9' })
  })
})
