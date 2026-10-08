// The Electron half of ADR-0070. An app that holds an `fs` grant shows its own files by URL: the
// page's request for `/orivon/app/<path>` on its own origin is answered from the files `orivon.fs`
// reads, instead of by the app's host. The decision is pure and lives in
// ../../broker/policy/app-files-by-url.ts, with the T1 reasoning.
//
// How a request reaches the bytes. A session cannot answer an `http:` request from a granted loopback
// origin without taking over every `http:` request of that session, so a web-request handler redirects
// the one request to the `orivon-file:` scheme and a handler for that scheme (registered on the same
// session) streams the file. The redirect target carries a MAC only this process can make, so a page
// that asks for the scheme directly, or for another app's file, is refused.
//
// Installed on the default session, where a granted origin's page runs, and on each session an app is
// served from. Both register through the web-request owner, never a raw `session.webRequest`.

import { session } from 'electron'
import type { Session, WebRequestFilter } from 'electron'
import type { Broker } from '../../broker/broker-contracts.js'
import { APP_FILE_SCHEME, appFileVerdict } from '../../broker/policy/app-files-by-url.js'
import { requestingDocumentOf } from '../../broker/policy/own-listener-media.js'
import { forEachAppSession, holdsFsGrant } from '../../loader/electron/serve.js'
import type { Subsystem } from '../registry.js'
import { createAppFileServer } from './app-file-response.js'
import { frameOf } from './own-listener-media-gate.js'
import { webRequestOwnerFor } from './web-request-owner.js'

/** Only what an `<img>`, CSS image, `<audio>` or `<video>` asks for: the types the widened CSP admits. */
export const APP_FILES_FILTER: WebRequestFilter = {
  urls: ['http://*/orivon/app/*', 'https://*/orivon/app/*'],
  types: ['image', 'media']
}

const files = createAppFileServer()

/** Registers the redirect on `target`: a verified request for an app's own file is sent to `orivon-file:`. */
export function installAppFilesGate (target: Session, broker: () => Broker | undefined): void {
  webRequestOwnerFor(target).onBeforeRequest(0, APP_FILES_FILTER, () => true, async (details, current) => {
    const live = broker()
    if (live === undefined) return current
    const document = requestingDocumentOf(frameOf(details))
    const holdsFs = document.kind === 'web' && await holdsFsGrant(live, document.origin)
    const verdict = appFileVerdict({ document, url: details.url, method: details.method, holdsFs })
    if (verdict.kind === 'pass') return current
    if (verdict.kind === 'refuse') return { ...current, cancel: true }
    return { ...current, redirectURL: files.urlFor(verdict.origin, verdict.encodedPath) }
  })
}

/** Registers the `orivon-file:` handler on `target`. The scheme is privileged in ../pages/internal-session.ts. */
export function installAppFileHandler (target: Session, broker: () => Broker | undefined): void {
  target.protocol.handle(APP_FILE_SCHEME, async (request) => {
    const live = broker()
    return live === undefined ? new Response(null, { status: 404 }) : await files.serve(request, live)
  })
}

export const appFilesByUrlSubsystem: Subsystem = {
  name: 'app-files-by-url',
  // Without the gate no page asks for the scheme, and without the handler the redirect fails: the two go together.
  critical: true,
  afterReady: (ctx) => {
    const broker = (): Broker | undefined => ctx.broker
    const install = (target: Session): void => {
      installAppFileHandler(target, broker)
      installAppFilesGate(target, broker)
    }
    install(session.defaultSession)
    forEachAppSession(install)
  }
}
