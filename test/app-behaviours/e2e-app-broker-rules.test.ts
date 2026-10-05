// The rules the broker applies to an app, driven from a real page over the real IPC pipe against real
// sockets and a real profile: what a grant reaches, what it refuses, and what an app that ports a Node
// program gets back. One launch. Every refusal is a rejected call with a code, a positive signal; none is
// read from an absence. Every check carries the id of the behaviour it protects
// (test/app-behaviours/catalogue.md), so a change in src/broker/ that breaks an app names it here.
//
// The page is a bare loopback origin made an app by the developer-only grant, so the e2e build is required:
//   node scripts/build-e2e.mjs && node scripts/run-headless.mjs npx vitest run --config test/vitest.e2e.config.ts test/app-behaviours/e2e-app-broker-rules.test.ts
import { createServer as createTcpServer } from 'node:net'
import type { AddressInfo, Server as TcpServer, Socket } from 'node:net'
import { createServer as createTlsServer } from 'node:tls'
import type { Server as TlsServer } from 'node:tls'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { generateSelfSignedFixture } from '../../src/broker/adapters/tests/tls-adapter.test-helpers.js'
import { appManifest, grantApp, pageCall, startAppServer, type AppServer } from './app-behaviour-support.js'
import { runPhase } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { launchShell, QA_TEST_TIMEOUT_MS, visit } from '../support/qa-helpers.js'

let server: AppServer
let echo: TcpServer
let busy: TcpServer
let tls: TlsServer
const sockets = new Set<Socket>()

const listen = async <T extends TcpServer>(s: T): Promise<number> => {
  await new Promise<void>((resolve) => { s.listen(0, '127.0.0.1', resolve) })
  return (s.address() as AddressInfo).port
}

beforeAll(async () => {
  server = await startAppServer()
  echo = createTcpServer((socket) => { sockets.add(socket); socket.on('error', () => {}); socket.pipe(socket) })
  busy = createTcpServer((socket) => { sockets.add(socket); socket.on('error', () => {}) })
  const fixture = generateSelfSignedFixture()
  tls = createTlsServer({ key: fixture.key, cert: fixture.cert }, (socket) => { sockets.add(socket); socket.on('error', () => {}); socket.end('hello over tls') })
})
afterAll(async () => {
  await server.close()
  for (const socket of sockets) socket.destroy()
  await Promise.all([echo, busy, tls].map(async (s) => await new Promise<void>((resolve) => { s.close(() => { resolve() }) })))
  expect(await assertNoElectronSurvivors()).toEqual([])
})

interface Outcome { readonly ok: boolean, readonly code?: string, readonly platformCode?: string, readonly message?: string, readonly value?: unknown }

it('[app:tcp-connect-to-granted-loopback-port] [app:wildcard-host-never-reaches-loopback] [app:reserved-port-needs-exact-pattern] [app:concurrent-sockets-limit-holds] [app:second-listener-gets-eaddrinuse] [app:fs-quota-refuses-past-limit] [app:fs-confined-to-app-root] [app:tls-self-signed-refused-unless-opted-out] the rules the broker applies to an app', async () => {
  const echoPort = await listen(echo)
  const busyPort = await listen(busy)
  const tlsPort = await listen(tls)
  const manifest = appManifest('broker-rules', {
    net: { tcp: { connect: [`127.0.0.1:${String(echoPort)}`, '*:*'], listen: { local: [String(busyPort), '0'] } }, https: { connect: [`localhost:${String(tlsPort)}`] }, concurrentSockets: 2 },
    fs: { quotaBytes: 1024 }
  })
  const { app, chrome } = await launchShell()
  try {
    await runPhase('broker rules', async (check) => {
      await grantApp(app, server.origin, manifest, [
        { capability: 'tcp.connect', patterns: [`127.0.0.1:${String(echoPort)}`, '*:*'] },
        { capability: 'tcp.listen.local', patterns: [String(busyPort), '0'] },
        { capability: 'https.connect', patterns: [`localhost:${String(tlsPort)}`] },
        { capability: 'fs', patterns: [] }
      ])
      const view = await visit(app, chrome, `${server.origin}/`)
      const outcomes = await pageCall(server, view, async (ports: { echo: number, busy: number, tls: number }) => {
        interface Failure { ok: false, code?: string | undefined, platformCode?: string | undefined, message?: string | undefined }
        type Result<T> = { ok: true, value: T } | Failure
        const orivon = (window as unknown as { orivon: {
          net: {
            connect: (o: { host: string, port: number }) => Promise<{ readable: ReadableStream<Uint8Array>, writable: WritableStream<Uint8Array>, close: () => Promise<void> }>
            connectSecure: (o: { host: string, port: number, rejectUnauthorized?: boolean }) => Promise<{ readable: ReadableStream<Uint8Array>, authorized: boolean, close: () => Promise<void> }>
            listen: (o: { port: number }) => Promise<{ localPort: number, close: () => Promise<void> }>
          }
          fs: { readFile: (p: string) => Promise<Uint8Array>, writeFile: (p: string, d: Uint8Array) => Promise<void> }
        } }).orivon
        const attempt = async <T>(run: () => Promise<T>): Promise<Result<T>> => {
          try {
            // A broken refusal would dial for real and hang; bound it so the check names what failed.
            const value = await Promise.race([run(), new Promise<never>((_resolve, reject) => { setTimeout(() => { reject({ code: 'timeout', message: 'no answer in 8 s' }) }, 8_000) })])
            return { ok: true, value }
          } catch (error) {
            const e = error as { code?: string, platformCode?: string, message?: string }
            return { ok: false, code: e.code, platformCode: e.platformCode, message: e.message }
          }
        }
        const summary = <T>(result: Result<T>, value?: unknown): Record<string, unknown> => result.ok ? { ok: true, value } : { ok: false, code: result.code, platformCode: result.platformCode, message: result.message }
        const out: Record<string, Record<string, unknown>> = {}

        // The exact loopback pattern reaches the echo server, and bytes come back.
        const sent = new TextEncoder().encode('round trip')
        const echoed = await attempt(async () => {
          const socket = await orivon.net.connect({ host: '127.0.0.1', port: ports.echo })
          try {
            const writer = socket.writable.getWriter()
            await writer.write(sent)
            const reader = socket.readable.getReader()
            let got = ''
            while (got.length < sent.length) {
              const { value, done } = await reader.read()
              if (done) break
              got += new TextDecoder().decode(value)
            }
            return got
          } finally {
            await socket.close()
          }
        })
        out['exact'] = summary(echoed, echoed.ok ? echoed.value : undefined)

        // `*:*` never reaches loopback: a live listener on another port is still refused.
        out['wildcardLoopback'] = summary(await attempt(async () => { await (await orivon.net.connect({ host: '127.0.0.1', port: ports.busy })).close() }))
        // A reserved port is reached only by a pattern naming it.
        out['reserved'] = summary(await attempt(async () => { await (await orivon.net.connect({ host: '93.184.216.34', port: 6667 })).close() }))

        // concurrentSockets: 2 refuses the third socket, and takes one again after a close.
        const first = await orivon.net.connect({ host: '127.0.0.1', port: ports.echo })
        const second = await orivon.net.connect({ host: '127.0.0.1', port: ports.echo })
        out['third'] = summary(await attempt(async () => { await (await orivon.net.connect({ host: '127.0.0.1', port: ports.echo })).close() }))
        await first.close()
        let after: Result<void> = { ok: false, code: 'never tried' }
        for (let i = 0; i < 50 && !after.ok; i++) {
          after = await attempt(async () => { await (await orivon.net.connect({ host: '127.0.0.1', port: ports.echo })).close() })
          if (!after.ok) await new Promise<void>((resolve) => { setTimeout(resolve, 100) })
        }
        out['afterClose'] = summary(after)
        await second.close()

        // A second listener on a port something else holds fails with EADDRINUSE.
        out['listenBusy'] = summary(await attempt(async () => { await (await orivon.net.listen({ port: ports.busy })).close() }))

        // The quota refuses a write past the limit and leaves the earlier file whole.
        out['quotaFirst'] = summary(await attempt(async () => { await orivon.fs.writeFile('one.bin', new Uint8Array(600)) }))
        out['quotaSecond'] = summary(await attempt(async () => { await orivon.fs.writeFile('two.bin', new Uint8Array(600)) }))
        const kept = await attempt(async () => (await orivon.fs.readFile('one.bin')).length)
        out['quotaKept'] = summary(kept, kept.ok ? kept.value : undefined)
        // A path outside the app's root is refused.
        out['outside'] = summary(await attempt(async () => await orivon.fs.readFile('../outside.txt')))

        // TLS: a self-signed certificate is refused by default and accepted when the app opts out.
        out['tlsDefault'] = summary(await attempt(async () => { await (await orivon.net.connectSecure({ host: 'localhost', port: ports.tls })).close() }))
        const optedOut = await attempt(async () => {
          const socket = await orivon.net.connectSecure({ host: 'localhost', port: ports.tls, rejectUnauthorized: false })
          try {
            const reader = socket.readable.getReader()
            let got = ''
            for (;;) {
              const { value, done } = await reader.read()
              if (done) break
              got += new TextDecoder().decode(value)
            }
            return { got, authorized: socket.authorized }
          } finally {
            await socket.close()
          }
        })
        out['tlsOptOut'] = summary(optedOut, optedOut.ok ? optedOut.value : undefined)
        return out
      }, { echo: echoPort, busy: busyPort, tls: tlsPort }) as unknown as Record<string, Outcome>

      const codeOf = (o: Outcome | undefined): string => (o === undefined ? 'missing' : o.ok ? 'ok' : `${o.code ?? '?'}${o.platformCode === undefined ? '' : `/${o.platformCode}`}`)
      const show = (key: string): string => JSON.stringify(outcomes[key])
      check('[app:tcp-connect-to-granted-loopback-port] a connection to the exact loopback port the manifest names reaches it and the bytes come back', outcomes['exact']?.ok === true && outcomes['exact']?.value === 'round trip', show('exact'))
      check('[app:wildcard-host-never-reaches-loopback] a `*:*` grant does not reach a loopback port something is listening on: denied', codeOf(outcomes['wildcardLoopback']) === 'denied', show('wildcardLoopback'))
      check('[app:reserved-port-needs-exact-pattern] a `*:*` grant does not reach a public address on a reserved port (6667): denied', codeOf(outcomes['reserved']) === 'denied', show('reserved'))
      check('[app:concurrent-sockets-limit-holds] with concurrentSockets 2, a third socket is refused: limit', codeOf(outcomes['third']) === 'limit', show('third'))
      check('[app:concurrent-sockets-limit-holds] and a socket opens again once one is closed', outcomes['afterClose']?.ok === true, show('afterClose'))
      check('[app:second-listener-gets-eaddrinuse] listening on a port another program holds fails with EADDRINUSE', /EADDRINUSE/.test(`${show('listenBusy')}`), show('listenBusy'))
      check('[app:fs-quota-refuses-past-limit] a write that would pass the 1024-byte quota is refused as limit, and the earlier 600-byte file is intact', outcomes['quotaFirst']?.ok === true && codeOf(outcomes['quotaSecond']) === 'limit' && outcomes['quotaKept']?.value === 600, `${show('quotaFirst')} ${show('quotaSecond')} ${show('quotaKept')}`)
      check('[app:fs-confined-to-app-root] a path that climbs out of the app root is refused: denied', codeOf(outcomes['outside']) === 'denied', show('outside'))
      check('[app:tls-self-signed-refused-unless-opted-out] a self-signed server is refused by default: unreachable with a platform code', /^unreachable\//.test(codeOf(outcomes['tlsDefault'])), show('tlsDefault'))
      check('[app:tls-self-signed-refused-unless-opted-out] and reached, unauthorized, when the app sets rejectUnauthorized false', outcomes['tlsOptOut']?.ok === true && (outcomes['tlsOptOut']?.value as { got?: string, authorized?: boolean } | undefined)?.got === 'hello over tls' && (outcomes['tlsOptOut']?.value as { authorized?: boolean } | undefined)?.authorized === false, show('tlsOptOut'))
    })
  } finally {
    await closeElectron(app)
  }
}, QA_TEST_TIMEOUT_MS * 2)
