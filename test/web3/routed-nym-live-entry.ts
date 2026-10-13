// Bundled by ./e2e-routed-nym-live.test.ts into the fixture app's script: one HTTPS request to a service that answers
// with the address it saw, made with the page's own `orivon.net.connectSecure`.

interface OrivonSocket {
  readonly readable: ReadableStream<Uint8Array>
  readonly writable: WritableStream<Uint8Array>
  close: () => Promise<void>
}

interface Reply {
  readonly ok: boolean
  readonly detail: string
}

const HOST = 'api.ipify.org'
const TIMEOUT_MS = 120_000

async function exitAddress (): Promise<Reply> {
  try {
    const net = (globalThis as unknown as { orivon: { net: { connectSecure: (opts: { host: string, port: number }) => Promise<OrivonSocket> } } }).orivon.net
    const socket = await net.connectSecure({ host: HOST, port: 443 })
    try {
      const writer = socket.writable.getWriter()
      await writer.write(new TextEncoder().encode(`GET / HTTP/1.1\r\nHost: ${HOST}\r\nConnection: close\r\nUser-Agent: orivon-live-check\r\n\r\n`))
      writer.releaseLock()
      const reader = socket.readable.getReader()
      const chunks: string[] = []
      const decoder = new TextDecoder()
      const deadline = Date.now() + TIMEOUT_MS
      while (Date.now() < deadline) {
        const next = await reader.read()
        if (next.done) break
        chunks.push(decoder.decode(next.value, { stream: true }))
      }
      const answer = chunks.join('')
      return { ok: answer.startsWith('HTTP/1.1 200'), detail: answer.split('\r\n\r\n').pop()?.trim() ?? '' }
    } finally {
      await socket.close().catch(() => {})
    }
  } catch (error) {
    return { ok: false, detail: String((error as { message?: string }).message ?? error) }
  }
}

;(globalThis as unknown as { routedNymLive: unknown }).routedNymLive = { exitAddress }
