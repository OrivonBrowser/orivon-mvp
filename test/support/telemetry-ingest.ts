// A loopback stand-in for the telemetry server: it records what is posted and answers 204 with no
// body, as the real one does. A spec that turns telemetry on points the launch at it through
// ORIVON_TELEMETRY_URL, so nothing it sends can leave the machine.
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface IngestRequest {
  readonly path: string
  readonly body: Record<string, unknown>
}

export interface Ingest {
  /** What ORIVON_TELEMETRY_URL is set to. */
  readonly url: string
  readonly requests: IngestRequest[]
  /** Answer the next requests with this status instead of 204; 204 puts it back. */
  respondWith: (status: number) => void
  close: () => Promise<void>
}

export async function startIngest (): Promise<Ingest> {
  const requests: IngestRequest[] = []
  let status = 204
  const server = createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => { chunks.push(chunk) })
    req.on('end', () => {
      try {
        requests.push({ path: req.url ?? '', body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> })
      } catch {
        status = 400
      }
      res.statusCode = status
      res.end()
    })
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    url: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/v1/`,
    requests,
    respondWith: (next) => { status = next },
    close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) }
  }
}

/** A fresh folder to stand for the system-wide telemetry home, and its removal. */
export async function telemetryHomeFolder (): Promise<{ home: string, remove: () => Promise<void> }> {
  const home = await mkdtemp(join(tmpdir(), 'orivon-telemetry-home-'))
  return { home, remove: async () => { await rm(home, { recursive: true, force: true }) } }
}
