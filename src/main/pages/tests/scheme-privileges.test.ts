import { describe, expect, it, vi } from 'vitest'

const registered: Array<Array<{ scheme: string, privileges: Record<string, boolean> }>> = []

vi.mock('electron', () => ({
  app: {},
  session: {},
  protocol: { registerSchemesAsPrivileged: (schemes: typeof registered[number]) => { registered.push(schemes) } }
}))

const { registerInternalScheme } = await import('../internal-session.js')

describe('registerInternalScheme', () => {
  registerInternalScheme()
  const byScheme = new Map((registered[0] ?? []).map((entry) => [entry.scheme, entry.privileges]))

  it('registers the schemes in one call, since Electron allows only one', () => {
    expect(registered).toHaveLength(1)
  })

  it.each(['orivon', 'orivon-shell'])('lets V8 keep the compiled scripts of %s, which needs standard beside it', (scheme) => {
    expect(byScheme.get(scheme)).toMatchObject({ standard: true, codeCache: true })
  })

  it('keeps the privileges that open a page to more away from the shell scheme', () => {
    expect(byScheme.get('orivon-shell')).toEqual({ standard: true, secure: true, codeCache: true })
  })

  it.each(['orivon-file', 'crx'])('does not give %s a code cache: it serves no script of the browser', (scheme) => {
    expect(byScheme.get(scheme)?.['codeCache']).toBeUndefined()
  })
})
