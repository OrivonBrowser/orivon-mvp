// createPreloadRecovery's own onReloadBoundary contract: called once before
// removeExtension ('start') and once after loadExtension settles ('end'),
// on both success and failure -- extensions-dnr.ts's beginDnrReload/
// endDnrReload (wired at extension-host.ts's call site, never imported
// here: this file's own header says why) rely on 'end' always firing so a
// marked id is never left stuck.
import { describe, expect, it, vi } from 'vitest'
import { createPreloadRecovery, extensionIdFromScope, type PreloadRecoveryDeps } from '../extension-sw-preload-recovery.js'

const SCOPE = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop/'
const ID = 'abcdefghijklmnopabcdefghijklmnop'

function baseDeps (overrides: Partial<PreloadRecoveryDeps> = {}): PreloadRecoveryDeps {
  return {
    getExtensionPath: () => '/fake/path',
    removeExtension: vi.fn(),
    loadExtension: vi.fn(async () => undefined),
    ...overrides,
  }
}

describe('extensionIdFromScope', () => {
  it('extracts the id from a chrome-extension:// scope', () => {
    expect(extensionIdFromScope(SCOPE)).toBe(ID)
  })

  it('is undefined for anything else', () => {
    expect(extensionIdFromScope('https://example.com/')).toBeUndefined()
    expect(extensionIdFromScope('chrome-extension://tooshort/')).toBeUndefined()
  })
})

describe('createPreloadRecovery: onReloadBoundary', () => {
  it('fires \'start\' before removeExtension and \'end\' after loadExtension settles, in that order', async () => {
    const calls: string[] = []
    const deps = baseDeps({
      removeExtension: () => { calls.push('removeExtension') },
      loadExtension: async () => { calls.push('loadExtension'); return undefined },
    })
    const onReloadBoundary = vi.fn((id: string, phase: 'start' | 'end') => { calls.push(`${phase}:${id}`) })
    const recovery = createPreloadRecovery({ ...deps, onReloadBoundary })

    await recovery.handleUnhealthyWorker(SCOPE)

    expect(calls).toEqual([`start:${ID}`, 'removeExtension', 'loadExtension', `end:${ID}`])
  })

  it('still fires \'end\' when loadExtension rejects -- a marked id must never be left stuck', async () => {
    const onReloadBoundary = vi.fn()
    const deps = baseDeps({ loadExtension: async () => { throw new Error('boom') }, onReloadBoundary })
    const recovery = createPreloadRecovery(deps)

    await expect(recovery.handleUnhealthyWorker(SCOPE)).rejects.toThrow('boom')

    expect(onReloadBoundary).toHaveBeenNthCalledWith(1, ID, 'start')
    expect(onReloadBoundary).toHaveBeenNthCalledWith(2, ID, 'end')
  })

  it('is never called at all when it is left out (a caller with nothing to protect)', async () => {
    const recovery = createPreloadRecovery(baseDeps())
    await expect(recovery.handleUnhealthyWorker(SCOPE)).resolves.toBeUndefined()
  })

  it('is never called for a scope with no resolvable extension id, or an already-retried one', async () => {
    const onReloadBoundary = vi.fn()
    const recovery = createPreloadRecovery(baseDeps({ onReloadBoundary }))

    await recovery.handleUnhealthyWorker('https://not-an-extension/')
    expect(onReloadBoundary).not.toHaveBeenCalled()

    await recovery.handleUnhealthyWorker(SCOPE)
    onReloadBoundary.mockClear()
    await recovery.handleUnhealthyWorker(SCOPE) // second report for the same id -- bounded to one retry
    expect(onReloadBoundary).not.toHaveBeenCalled()
  })
})
