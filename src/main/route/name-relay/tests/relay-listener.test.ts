// The relay's listener on a real loopback port: a caller without its secret is refused before anything is asked, a CONNECT with it reaches
// the proxy by address, a refusal is counted and logged as a word, and draining lets a tunnel finish.

import { connect as netConnect } from 'node:net'
import type { Socket } from 'node:net'
import { afterEach, describe, expect, it } from 'vitest'
import { createRelayFailures } from '../relay-failures.js'
import type { RefusalWord } from '../relay-failures.js'
import { startRelayListener } from '../relay-listener.js'
import { LookupRefusal } from '../proxied-lookup.js'
import type { NameLookup } from '../proxied-lookup.js'
import { closeAll, closeLater, keep, startConnectProxy, startEcho } from './upstream-fixtures.test-helpers.js'

afterEach(closeAll)

const SITE = 'shop.example'
const ADDRESS = '203.0.113.7'

async function connectThrough (port: number, target: string, authorization: string | undefined): Promise<{ status: string, socket: Socket }> {
  const socket = keep(netConnect({ host: '127.0.0.1', port }))
  await new Promise<void>((resolve) => { socket.once('connect', resolve) })
  socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n${authorization === undefined ? '' : `Proxy-Authorization: ${authorization}\r\n`}\r\n`)
  const head = await new Promise<string>((resolve) => {
    let text = ''
    const onData = (chunk: Buffer): void => {
      text += chunk.toString()
      if (text.includes('\r\n\r\n')) { socket.off('data', onData); resolve(text) }
    }
    socket.on('data', onData)
    socket.on('close', () => { resolve(text) })
  })
  return { status: head.split('\r\n')[0] ?? '', socket }
}

async function start (proxyPort: number, lookup: NameLookup, refused: RefusalWord[] = []): Promise<{ port: number, authorization: string, systemAsked: string[], stop: () => Promise<void>, close: () => Promise<void>, failures: ReturnType<typeof createRelayFailures> }> {
  const systemAsked: string[] = []
  const failures = createRelayFailures()
  const listener = await startRelayListener({
    systemAnswer: async (url) => { systemAsked.push(url); return `PROXY 127.0.0.1:${String(proxyPort)}` },
    lookup,
    drop: () => {},
    lookupDirect: async () => [],
    failures,
    onRefused: (word) => { refused.push(word) }
  }, () => {})
  closeLater(listener.close)
  const authorization = `Basic ${Buffer.from(`${listener.username}:${listener.secret}`).toString('base64')}`
  return { port: listener.port, authorization, systemAsked, stop: listener.stop, close: listener.close, failures }
}

describe('the listener', () => {
  it('asks a caller without its secret for it and asks the system, the lookup and the proxy nothing', async () => {
    const proxy = await startConnectProxy({ targets: {} })
    const lookups: string[] = []
    const relay = await start(proxy.port, async (host) => { lookups.push(host); return { addresses: [ADDRESS] } })
    expect((await connectThrough(relay.port, `${SITE}:443`, undefined)).status).toBe('HTTP/1.1 407 Proxy Authentication Required')
    expect((await connectThrough(relay.port, `${SITE}:443`, 'Basic d3Jvbmc6c2VjcmV0')).status).toBe('HTTP/1.1 407 Proxy Authentication Required')
    expect([relay.systemAsked, lookups, proxy.seen]).toEqual([[], [], []])
  })

  it('carries a CONNECT to the proxy by address, with the name looked up and never sent', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${ADDRESS}:443`]: echo.port } })
    const relay = await start(proxy.port, async () => ({ addresses: [ADDRESS] }))
    const { status, socket } = await connectThrough(relay.port, `${SITE}:443`, relay.authorization)
    expect(status).toBe('HTTP/1.1 200 Connection Established')
    const echoed = new Promise<string>((resolve) => { socket.once('data', (chunk: Buffer) => { resolve(chunk.toString()) }) })
    socket.write('ping')
    expect(await echoed).toBe('ping')
    expect(relay.systemAsked).toEqual([`https://${SITE}/`])
    expect(proxy.seen.map((seen) => seen.requestLine)).toEqual([`CONNECT ${ADDRESS}:443 HTTP/1.1`])
    expect(JSON.stringify(proxy.seen)).not.toContain('shop')
    await relay.close()
  })

  it('answers a refusal with a 502, counts its word, tells the log the word, and notes it for the sheet', async () => {
    const proxy = await startConnectProxy({ targets: {} })
    const refused: RefusalWord[] = []
    const relay = await start(proxy.port, async () => { throw new LookupRefusal('not-found') }, refused)
    const { status } = await connectThrough(relay.port, `${SITE}:443`, relay.authorization)
    expect(status).toBe('HTTP/1.1 502 Bad Gateway')
    expect(refused).toEqual(['not-found'])
    expect(relay.failures.counts()['not-found']).toBe(1)
    expect(relay.failures.reasonFor(SITE, 443)).toBe('not-found')
    await relay.close()
  })

  it('refuses a name the verifier serves with a 403 before asking the system anything', async () => {
    const proxy = await startConnectProxy({ targets: {} })
    const relay = await start(proxy.port, async () => ({ addresses: [ADDRESS] }))
    expect((await connectThrough(relay.port, 'vitalik.eth:443', relay.authorization)).status).toBe('HTTP/1.1 403 Forbidden')
    expect(relay.systemAsked).toEqual([])
    await relay.close()
  })

  it('stops accepting when told to stop, and lets a tunnel in flight finish', async () => {
    const echo = await startEcho()
    const proxy = await startConnectProxy({ targets: { [`${ADDRESS}:443`]: echo.port } })
    const relay = await start(proxy.port, async () => ({ addresses: [ADDRESS] }))
    const { socket } = await connectThrough(relay.port, `${SITE}:443`, relay.authorization)
    const stopped = relay.stop()
    await expect(new Promise<void>((resolve, reject) => {
      const probe = netConnect({ host: '127.0.0.1', port: relay.port })
      probe.once('connect', () => { probe.destroy(); resolve() })
      probe.once('error', reject)
    })).rejects.toMatchObject({ code: 'ECONNREFUSED' })
    const echoed = new Promise<string>((resolve) => { socket.once('data', (chunk: Buffer) => { resolve(chunk.toString()) }) })
    socket.write('still')
    expect(await echoed).toBe('still')
    socket.destroy()
    await stopped
  })
})
