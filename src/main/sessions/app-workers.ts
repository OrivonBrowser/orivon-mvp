// What a service worker of an allowed app that runs where websites run must have been: one whose script the shell served.
// A document such a worker answers has no response any web-request hook sees, so its grants rest on the worker being the
// app's own (`./session-attribution.ts`). Workers a website left are removed before the serving begins
// (`./website-workers.ts`); from the moment the serving is prepared, a worker script (or one it imports) that the shell did not
// serve is refused here, so no worker the check never saw can be registered. Electron-free: the rule only.

/** The origins (as the URL parser spells them) whose worker scripts the shell must have served. */
const guarded = new Set<string>()

function originKey (origin: string): string | undefined {
  try {
    return new URL(origin).origin
  } catch {
    return undefined
  }
}

/** From now until `releaseWorkerScripts`, a worker script of `origin` is refused unless the shell served it. Call before the website's workers are removed. */
export function guardWorkerScripts (origin: string): void {
  const key = originKey(origin)
  if (key !== undefined) guarded.add(key)
}

/** The shell stops serving `origin`: its workers are a website's again. */
export function releaseWorkerScripts (origin: string): void {
  const key = originKey(origin)
  if (key !== undefined) guarded.delete(key)
}

/** What a web-request hook knows of a response when its headers arrive. */
export interface ScriptResponse {
  readonly url: string
  /** Electron's name for the kind of request: a service worker's script is a `script` with no page behind it. */
  readonly resourceType: string
  /** Whether a page of the browser made the request: a worker's own loads are made with none. */
  readonly hasPage: boolean
  readonly answeredByShell: boolean
}

/** Whether the response is a worker script of a guarded origin that the shell did not serve. */
export function refusesWorkerScript (response: ScriptResponse): boolean {
  if (response.resourceType !== 'script' || response.hasPage || response.answeredByShell) return false
  const key = originKey(response.url)
  return key !== undefined && guarded.has(key)
}
