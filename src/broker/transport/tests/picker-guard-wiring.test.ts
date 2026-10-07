import { tmpdir } from 'node:os'
import { describe, expect, it, vi } from 'vitest'
import { additionalProtectedRoots, notifyPickRefused, privateSessionGuard } from '../picker-guard-wiring.js'

// Everything in this file is a plain function of `node:os`/`node:path` facts, a
// stub `app` and an injected sink: it imports no `electron`, so this runs under
// plain vitest exactly as `picker-dialog-wording.test.ts` does for its own
// electron-free half.

describe('additionalProtectedRoots', () => {
  const appNamed = (name: string): { getPath: (path: string) => string, getName: () => string } => ({ getPath: (path: string) => (path === 'appData' ? '/home/user/.config' : ''), getName: () => name })

  it('names the default profile\'s own directory, reconstructed from appData + the app name', () => {
    expect(additionalProtectedRoots(appNamed('Orivon'))).toContain('/home/user/.config/Orivon')
  })

  it('names the other Orivon program\'s directory too: a run from source and an installed package hold one person\'s data', () => {
    for (const name of ['orivon', 'orivon-source']) {
      expect([...additionalProtectedRoots(appNamed(name))].sort()).toEqual(['/home/user/.config/orivon', '/home/user/.config/orivon-source'])
    }
  })
})

describe('privateSessionGuard', () => {
  it('names the real temp directory and a working isPrivateDirName predicate', () => {
    const guard = privateSessionGuard()

    expect(guard.tempDir).toBe(tmpdir())
    expect(guard.isPrivateDirName('orivon-private-ab12cd')).toBe(true)
    expect(guard.isPrivateDirName('Downloads')).toBe(false)
  })
})

describe('notifyPickRefused', () => {
  const info = { origin: 'https://app.example', appName: 'Notes', reason: 'it holds Orivon\'s own data' }

  it('hands the notice to the sink the shell supplies, naming the app and its origin', () => {
    const show = vi.fn()
    notifyPickRefused(info, show)
    expect(show).toHaveBeenCalledExactlyOnceWith({
      title: 'Folder or file not allowed',
      message: '"Notes" (https://app.example) asked to use a folder or file Orivon will not hand over: it holds Orivon\'s own data.'
    })
  })

  it('names only the origin when the app has no name', () => {
    const show = vi.fn()
    notifyPickRefused({ ...info, appName: undefined }, show)
    expect(show.mock.calls[0]?.[0].message).toMatch(/^https:\/\/app\.example asked/)
  })

  it('only logs when there is nothing to show it on', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => { notifyPickRefused(info, undefined) }).not.toThrow()
    expect(log).toHaveBeenCalledTimes(1)
    log.mockRestore()
  })
})
