import { describe, expect, it } from 'vitest'
import { bundleTree } from '../../../broker/policy/bundle-hash.js'
import { fromBundleTree } from '../../../broker/policy/pin.js'
import { createAppRequestHandler } from '../serve.js'
import { ISOLATION_HEADERS } from '../csp.js'
import { manifestJson, memoryStorage, ORIGIN, utf8 } from '../../tests/test-helpers.js'

// A manifest's `crossOriginIsolated: true` puts the two isolation headers
// on every served asset -- the document, a worker script, a partial or an
// unsatisfiable-range response -- and a manifest without it puts them on
// none. A worker's own response must carry them, or it is not isolated
// (serve/csp.ts's ISOLATION_HEADERS doc); a miss here is silent, since the
// page still loads, only without SharedArrayBuffer.

const INDEX_HTML = '<!doctype html><title>t</title>'
const WORKER_JS = 'postMessage(1)'

async function installedStorage (manifestOverrides: Record<string, unknown>): Promise<ReturnType<typeof memoryStorage>> {
  const entries = [
    { path: '/.well-known/orivon.json', content: utf8(manifestJson({ assets: ['worker.js'], ...manifestOverrides })) },
    { path: '/index.html', content: utf8(INDEX_HTML) },
    { path: '/worker.js', content: utf8(WORKER_JS) }
  ]
  const tree = await bundleTree(entries)
  const storage = memoryStorage()
  for (const entry of entries) await storage.writeAsset(ORIGIN, entry.path, entry.content)
  await storage.writePin(ORIGIN, fromBundleTree(ORIGIN, tree.root, tree.assets, '1.0.0', 0))
  return storage
}

function isolationOf (response: Response): [string | null, string | null] {
  return [response.headers.get('cross-origin-opener-policy'), response.headers.get('cross-origin-embedder-policy')]
}

describe('createAppRequestHandler -- cross-origin isolation (Manifest.crossOriginIsolated)', () => {
  it('serves the document, a worker script, a 206 and a 416 with COOP same-origin and COEP credentialless when the manifest asks', async () => {
    const handler = await createAppRequestHandler(await installedStorage({ crossOriginIsolated: true }), ORIGIN)
    const expected = [ISOLATION_HEADERS['cross-origin-opener-policy'], ISOLATION_HEADERS['cross-origin-embedder-policy']]

    expect(isolationOf(await handler(new Request(`${ORIGIN}/`)))).toEqual(expected)
    expect(isolationOf(await handler(new Request(`${ORIGIN}/worker.js`)))).toEqual(expected)
    const partial = await handler(new Request(`${ORIGIN}/worker.js`, { headers: { range: 'bytes=0-3' } }))
    expect(partial.status).toBe(206)
    expect(isolationOf(partial)).toEqual(expected)
    const unsatisfiable = await handler(new Request(`${ORIGIN}/worker.js`, { headers: { range: 'bytes=999-1000' } }))
    expect(unsatisfiable.status).toBe(416)
    expect(isolationOf(unsatisfiable)).toEqual(expected)
  })

  it('serves nothing of the kind when the manifest does not ask', async () => {
    const handler = await createAppRequestHandler(await installedStorage({}), ORIGIN)
    expect(isolationOf(await handler(new Request(`${ORIGIN}/`)))).toEqual([null, null])
    expect(isolationOf(await handler(new Request(`${ORIGIN}/worker.js`)))).toEqual([null, null])
  })

  it('keeps the CSP beside the isolation headers', async () => {
    const handler = await createAppRequestHandler(await installedStorage({ crossOriginIsolated: true }), ORIGIN)
    const response = await handler(new Request(`${ORIGIN}/`))
    expect(response.headers.get('content-security-policy')).toContain("default-src 'self'")
  })
})
