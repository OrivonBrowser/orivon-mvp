// `shell.openExternal`: the browser itself is the system's handler for a URL.
// The other members act on host paths or the desktop and refuse by name.

import { refuse } from './errors.js'
import { notConsidered, refusingProxy } from './unimplemented.js'

export interface ElectronShell {
  openExternal(url: string, options?: { readonly activate?: boolean }): Promise<void>
}

export interface ShellDeps {
  readonly open: (url: string, target: string, features: string) => unknown
}

/** Members that act on a host path or the desktop: out of scope by design, not merely unbuilt. */
const DESKTOP_SHELL: ReadonlySet<string> = new Set(['openPath', 'showItemInFolder', 'trashItem', 'beep'])

export function createShell (deps: ShellDeps): ElectronShell {
  const known: ElectronShell = {
    async openExternal (url) {
      if (typeof url !== 'string' || !URL.canParse(url)) {
        throw refuse('shell.openExternal', 'invalid-usage',
          'shell.openExternal needs an absolute URL string, such as https://example.com/ or mailto:a@b.c.')
      }
      try {
        // noopener: window.open then returns null whether the tab opened or the browser declined it,
        // so the returned window says nothing and is not read.
        deps.open(url, '_blank', 'noopener,noreferrer')
      } catch (error) {
        throw refuse('shell.openExternal', 'invalid-usage',
          `the browser refused to open ${url}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
  }
  return refusingProxy(known, (prop) => DESKTOP_SHELL.has(prop)
    ? refuse(`shell.${prop}`, 'desktop-shell',
      `shell.${prop} acts on the host's files or desktop, out of scope for an Orivon app by design ` +
      '(compatibility-matrix.md Table 2).')
    : notConsidered(`shell.${prop}`))
}
