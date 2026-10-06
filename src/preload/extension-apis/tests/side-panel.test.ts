import { afterEach, describe, expect, it } from 'vitest'
import { sidePanelApi } from '../side-panel.js'

function run (declared: boolean) {
  const calls: string[] = []
  let built: Record<string, unknown> | undefined
  const crx = {
    declares: (permission: string) => declared && permission === 'sidePanel',
    call: (name: string) => () => { calls.push(name); return Promise.resolve() },
    event: (name: string) => ({ name }),
    define: (ns: string, make: (base: unknown) => object) => { built = { ns, ...make({ keep: 1 }) } }
  }
  ;(globalThis as { __crx?: unknown }).__crx = crx
  // Run from its own source text, as the library does.
  new Function(`return (${sidePanelApi.toString()})`)()()
  return { built, calls }
}

afterEach(() => { delete (globalThis as { __crx?: unknown }).__crx })

describe('sidePanelApi', () => {
  it('defines no namespace for an extension that does not declare sidePanel', () => {
    expect(run(false).built).toBeUndefined()
  })

  it('defines the seven calls and both events, and keeps what the library had', () => {
    const { built } = run(true)
    expect(Object.keys(built ?? {}).sort()).toEqual(['close', 'getLayout', 'getOptions', 'getPanelBehavior', 'keep', 'ns', 'onClosed', 'onOpened', 'open', 'setOptions', 'setPanelBehavior'])
    expect(built?.['ns']).toBe('sidePanel')
  })

  it('sends each call to the handler of its own name', async () => {
    const { built, calls } = run(true)
    for (const name of ['setOptions', 'getOptions', 'setPanelBehavior', 'getPanelBehavior', 'getLayout', 'open', 'close']) await (built?.[name] as () => Promise<void>)()
    expect(calls).toEqual(['setOptions', 'getOptions', 'setPanelBehavior', 'getPanelBehavior', 'getLayout', 'open', 'close'].map((name) => `sidePanel.${name}`))
  })
})
