// What the specs that end Chromium's network service share: the test seam main exposes of the restart (what it did,
// since Chromium offers no read of the resolver or the certificate check), the service's pid, and a plain loopback page
// that counts the requests it is asked.
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication } from 'playwright'

export interface NetworkServiceSeam {
  ended: number
  resent: number
  resolverCalls: Array<{ at: number, mode: string | undefined, servers: number }>
  certificateChecks: number[]
  holds: Array<{ outcome: string, requests: number }>
}

/** What a build that has not met the service ending reads. */
const EMPTY: NetworkServiceSeam = { ended: 0, resent: 0, resolverCalls: [], certificateChecks: [], holds: [] }

export async function seamOf (app: ElectronApplication): Promise<NetworkServiceSeam> {
  const seam = await app.evaluate(() => structuredClone((globalThis as { __orivonDevNetworkService?: NetworkServiceSeam }).__orivonDevNetworkService))
  return { ...EMPTY, ...seam }
}

export const NETWORK_SERVICE = 'network.mojom.NetworkService'

export const networkServicePid = async (app: ElectronApplication): Promise<number> =>
  await app.evaluate(({ app: electronApp }, service) => electronApp.getAppMetrics().find((metric) => metric.type === 'Utility' && metric.serviceName === service)?.pid ?? 0, NETWORK_SERVICE)

/** A page on loopback that counts the requests it answers, by path; the page itself is `/`. */
export interface CountedPage {
  readonly url: string
  readonly port: number
  /** How many requests asked for `path`. */
  hits: (path?: string) => number
  close: () => Promise<void>
}

export async function startCountedPage (title: (path: string) => string): Promise<CountedPage> {
  const seen: string[] = []
  const server = createServer((request, response) => {
    const path = request.url ?? '/'
    seen.push(path)
    response.writeHead(200, { 'content-type': 'text/html', 'cache-control': 'no-store' }).end(`<!doctype html><meta charset="utf-8"><title>${title(path)}</title><body>${title(path)}</body>`)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  const port = (server.address() as AddressInfo).port
  return {
    url: `http://127.0.0.1:${String(port)}/`,
    port,
    hits: (path = '/') => seen.filter((one) => one === path).length,
    close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) }
  }
}
