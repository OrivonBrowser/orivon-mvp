// Runs the text of a proxy script in a context of its own, as Chromium's PAC context does: the helpers a script may call are
// there, made inside the context so that none of them leads back to this realm, and the function it names is read from the global
// when it is asked. `extra` is for a script a test trusts: what it holds belongs to this realm.

import { createContext, runInContext } from 'node:vm'

export interface PacRun {
  /** The script's answer, called with `host` (by default the one Chromium hands a script: lower-case, the root dot kept). Throws as the script does. */
  readonly answer: (url: string, host?: string) => unknown
  /** The names of the global the script ran in. */
  readonly globals: () => string[]
}

/** The host Chromium hands a script for `url`. */
export function hostOf (url: string): string {
  return new URL(url).hostname
}

const HELPERS = `
var isPlainHostName = function (host) { return host.indexOf('.') < 0 };
var dnsDomainIs = function (host, domain) { return host.length >= domain.length && host.substring(host.length - domain.length) === domain };
`

/** Runs `source`, with `extra` added to the helpers. A script that throws or compiles badly makes this throw, as Chromium takes it for no script. */
export function runPac (source: string, extra: Record<string, unknown> = {}): PacRun {
  const context = createContext({ ...extra })
  runInContext(HELPERS, context)
  runInContext(source, context)
  return {
    answer: (url, host = hostOf(url)) => (runInContext('FindProxyForURL', context) as (url: string, host: string) => unknown)(url, host),
    globals: () => runInContext('Object.getOwnPropertyNames(globalThis)', context) as string[]
  }
}
