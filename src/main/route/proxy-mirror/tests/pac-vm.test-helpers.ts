// Runs the text of a proxy script in a context of its own, as Chromium's PAC context does: the helpers a script may call are
// there, and the function it names is read from the global when it is asked.

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

/** Runs `source`, with `extra` added to the helpers. A script that throws or compiles badly makes this throw, as Chromium takes it for no script. */
export function runPac (source: string, extra: Record<string, unknown> = {}): PacRun {
  const context = createContext({
    isPlainHostName: (host: string) => !host.includes('.'),
    dnsDomainIs: (host: string, domain: string) => host.endsWith(domain),
    ...extra
  })
  runInContext(source, context)
  return {
    answer: (url, host = hostOf(url)) => (runInContext('FindProxyForURL', context) as (url: string, host: string) => unknown)(url, host),
    globals: () => runInContext('Object.getOwnPropertyNames(globalThis)', context) as string[]
  }
}
