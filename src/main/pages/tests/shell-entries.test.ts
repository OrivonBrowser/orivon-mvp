import { describe, expect, it } from 'vitest'
import config from '../../../../electron.vite.config.js'
import { INTERNAL_PAGES } from '../internal-pages.js'
import { DEFAULT_SESSION_ENTRIES, SHELL_SESSION_ENTRIES } from '../../shell/shell-session.js'

type Config = { renderer?: { build?: { rollupOptions?: { input?: Record<string, string> } } } }

describe('the renderer build\'s entries', () => {
  const inputs = Object.keys((config as Config).renderer?.build?.rollupOptions?.input ?? {}).sort()
  const known = [
    ...SHELL_SESSION_ENTRIES,
    ...DEFAULT_SESSION_ENTRIES,
    ...INTERNAL_PAGES.map((page) => `page-${page}`)
  ].sort()

  // An entry the build makes and no session serves is dead weight; an entry a session lists and the build
  // does not make is a page that loads as a 404.
  it('are each an internal page or an entry one of the shell\'s two sessions serves, and the reverse', () => {
    expect(inputs).toEqual(known)
  })

  it('are never listed for both sessions', () => {
    const both = SHELL_SESSION_ENTRIES.filter((entry) => (DEFAULT_SESSION_ENTRIES as readonly string[]).includes(entry))
    expect(both).toEqual([])
  })
})
