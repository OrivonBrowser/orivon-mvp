import { afterEach, describe, expect, it } from 'vitest'
import { runtimeApi } from '../runtime.js'
import { LOADED_DNR_KEY } from '../../../broker/policy/extension-manifest.js'

type Listener = (details: unknown) => void
interface OnInstalled {
  addListener: (cb: Listener) => void
  removeListener: (cb: Listener) => void
  hasListener: (cb: Listener) => boolean
}

function run (context: 'worker' | 'page', answer: unknown, native: unknown = { id: 'x' }): {
  onInstalled: () => OnInstalled | undefined
  getManifest: () => unknown
  settle: () => Promise<void>
} {
  let defined: { onInstalled?: OnInstalled, getManifest?: () => unknown } | undefined
  const asked: Array<Promise<unknown>> = []
  ;(globalThis as { __crx?: unknown }).__crx = {
    context,
    call: () => () => { const p = Promise.resolve(answer); asked.push(p); return p },
    define: (_ns: string, build: (base: unknown) => { onInstalled?: OnInstalled }) => { defined = build(native) }
  }
  const rebuilt = new Function(`return (${runtimeApi.toString()})`)() as () => void
  rebuilt()
  return {
    onInstalled: () => defined?.onInstalled,
    getManifest: () => defined?.getManifest?.(),
    settle: async () => { await Promise.all(asked); await Promise.resolve(); await Promise.resolve() }
  }
}

afterEach(() => { delete (globalThis as { __crx?: unknown }).__crx })

describe('runtimeApi', () => {
  it('reads the key the loaded copy keeps the removed rulesets under', () => {
    expect(runtimeApi.toString()).toContain(LOADED_DNR_KEY)
  })

  it('leaves a page context to the native onInstalled', () => {
    expect(run('page', { reason: 'install' }).onInstalled()).toBeUndefined()
  })

  it('answers getManifest with the declarative_net_request the extension shipped, in a page and a worker', () => {
    const native = {
      getManifest: () => ({ name: 'x', x_orivon_declarative_net_request: { rule_resources: [{ id: 'a' }] } })
    }
    for (const context of ['page', 'worker'] as const) {
      expect(run(context, null, native).getManifest()).toEqual({ name: 'x', declarative_net_request: { rule_resources: [{ id: 'a' }] } })
    }
  })

  it('answers getManifest unchanged when nothing was moved out', () => {
    const native = { getManifest: () => ({ name: 'x', permissions: ['storage'] }) }
    expect(run('page', null, native).getManifest()).toEqual({ name: 'x', permissions: ['storage'] })
  })

  it('fires a listener added before the answer arrives, with the details', async () => {
    const { onInstalled, settle } = run('worker', { reason: 'update', previousVersion: '1.0.0' })
    const seen: unknown[] = []
    onInstalled()?.addListener((details) => seen.push(details))
    await settle()
    expect(seen).toEqual([{ reason: 'update', previousVersion: '1.0.0' }])
  })

  it('fires a listener added just after the answer arrived (a module worker adds its listeners late)', async () => {
    const { onInstalled, settle } = run('worker', { reason: 'install' })
    await settle()
    const seen: unknown[] = []
    onInstalled()?.addListener((details) => seen.push(details))
    await Promise.resolve()
    expect(seen).toEqual([{ reason: 'install' }])
  })

  it('fires nothing when the worker was not just installed', async () => {
    const { onInstalled, settle } = run('worker', null)
    const seen: unknown[] = []
    onInstalled()?.addListener((details) => seen.push(details))
    await settle()
    expect(seen).toEqual([])
  })

  it('fires a listener once, and not after it is removed', async () => {
    const { onInstalled, settle } = run('worker', { reason: 'install' })
    const seen: unknown[] = []
    const keep: Listener = (details) => seen.push(details)
    const drop: Listener = (details) => seen.push(details)
    onInstalled()?.addListener(keep)
    onInstalled()?.addListener(keep)
    onInstalled()?.addListener(drop)
    onInstalled()?.removeListener(drop)
    expect(onInstalled()?.hasListener(keep)).toBe(true)
    expect(onInstalled()?.hasListener(drop)).toBe(false)
    await settle()
    expect(seen).toHaveLength(1)
  })
})
