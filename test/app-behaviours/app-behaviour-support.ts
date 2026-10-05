// Shared plumbing for the app-behaviour specs (test/app-behaviours/catalogue.md): a loopback page on
// port 0 that also serves the script `asPage` runs, and the developer-only grant that makes the origin
// an app. A page calls `window.orivon` only from a script it loaded itself (ADR-0045), so every
// `orivon.*` call here goes through `pageCall`.

import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { ElectronApplication, Page } from 'playwright'
import type { Manifest } from '../../src/contracts/index.js'
import { asPage } from '../support/e2e-helpers.js'

export interface AppServer {
  readonly origin: string
  readonly setAsPageScript: (js: string) => void
  readonly close: () => Promise<void>
}

export interface Route { readonly type: string, readonly body: string }

/** A loopback server on port 0: `routes` by path, `/` an empty titled page unless given. */
export async function startAppServer (routes: Readonly<Record<string, Route>> = {}): Promise<AppServer> {
  let asPageScript = ''
  const server = createServer((req, res) => {
    const path = (req.url ?? '/').split('?')[0] ?? '/'
    if (path === '/__as-page-script.js') {
      res.writeHead(200, { 'content-type': 'text/javascript' })
      res.end(asPageScript)
      return
    }
    const route = routes[path] ?? (path === '/' ? { type: 'text/html; charset=utf-8', body: '<!doctype html><title>app</title><body>app</body>' } : undefined)
    if (route === undefined) {
      res.writeHead(404, { 'content-type': 'text/plain' })
      res.end('not found')
      return
    }
    res.writeHead(200, { 'content-type': route.type })
    res.end(route.body)
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    setAsPageScript: (js) => { asPageScript = js },
    close: async () => { await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() }) }
  }
}

export interface GrantSpec { readonly capability: string, readonly patterns: readonly string[] }

/** The manifest an origin registers with; `capabilities` is what the app declares. */
export function appManifest (id: string, capabilities: Manifest['capabilities']): Manifest {
  return { orivonApiVersion: 0, id: `app.orivon.behaviour.${id}`, name: `Behaviour ${id}`, version: '1.0.0', entry: 'index.html', capabilities }
}

/**
 * Registers `origin` with `manifest` and grants it each capability, through the developer-only hook.
 * Registered before the tab navigates: whether a tab is an app tab is fixed when its view is built.
 * The grant lives in memory for one launch, so a relaunch grants again.
 */
export async function grantApp (app: ElectronApplication, origin: string, manifest: Manifest, grants: readonly GrantSpec[]): Promise<void> {
  const installed = await app.evaluate(async (_electron, request) => {
    const hook = (globalThis as unknown as { __orivonDevGrant?: (r: unknown) => Promise<unknown> }).__orivonDevGrant
    if (typeof hook !== 'function') return false
    for (const grant of request.grants) {
      await hook({ origin: request.origin, manifest: request.manifest, capability: grant.capability, patterns: grant.patterns })
    }
    return true
  }, { origin, manifest, grants })
  if (!installed) throw new Error('globalThis.__orivonDevGrant is missing: run this against the e2e build (node scripts/build-e2e.mjs)')
}

/** Runs `fn` in `view` as a script the page loaded itself, so `window.orivon` answers it. `fn` closes over nothing. */
export async function pageCall<T> (server: AppServer, view: Page, fn: (...args: never[]) => T | Promise<T>, ...args: readonly unknown[]): Promise<T> {
  return await asPage(view, server.setAsPageScript, `${server.origin}/__as-page-script.js`, fn, ...args)
}
