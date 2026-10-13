// What the Settings page's Test action asks of a proxy: whether a SOCKS5 server is there and takes one of the two
// authentication methods the route offers. It sends the greeting and nothing after it, so it opens no stream to any
// destination and reveals nothing about an app.

import { connect } from 'node:net'

export type Socks5Probe =
  | { readonly ok: true, readonly authentication: 'none' | 'password' }
  | { readonly ok: false, readonly reason: 'unreachable' | 'silent' | 'not-socks5' | 'refused' }

export interface Socks5ProbeOptions {
  readonly host: string
  readonly port: number
  readonly timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5_000
const GREETING = Buffer.from([0x05, 0x02, 0x00, 0x02])

export async function probeSocks5 ({ host, port, timeoutMs = DEFAULT_TIMEOUT_MS }: Socks5ProbeOptions): Promise<Socks5Probe> {
  return await new Promise((resolve) => {
    const socket = connect({ host, port })
    let done = false
    const finish = (result: Socks5Probe): void => {
      if (done) return
      done = true
      clearTimeout(timer)
      socket.destroy()
      resolve(result)
    }
    const timer = setTimeout(() => { finish({ ok: false, reason: 'silent' }) }, timeoutMs)
    socket.once('error', () => { finish({ ok: false, reason: 'unreachable' }) })
    socket.once('connect', () => { socket.write(GREETING) })
    socket.once('close', () => { finish({ ok: false, reason: 'not-socks5' }) })
    socket.once('data', (reply: Buffer) => {
      if (reply.length < 2 || reply[0] !== 0x05) { finish({ ok: false, reason: 'not-socks5' }); return }
      if (reply[1] === 0x00) finish({ ok: true, authentication: 'none' })
      else if (reply[1] === 0x02) finish({ ok: true, authentication: 'password' })
      else if (reply[1] === 0xff) finish({ ok: false, reason: 'refused' })
      else finish({ ok: false, reason: 'not-socks5' })
    })
  })
}
