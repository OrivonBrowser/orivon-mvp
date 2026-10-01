import { afterEach, describe, expect, it, vi } from 'vitest'
import { permissionsApi } from '../permissions.js'

function build (userActivation: { isActive: boolean } | undefined) {
  const calls: Array<{ name: string, args: unknown[] }> = []
  let built: Record<string, (...args: unknown[]) => unknown> = {}
  const crx = {
    call: (name: string) => (...args: unknown[]) => { calls.push({ name, args }); return Promise.resolve(true) },
    event: (name: string) => ({ name }),
    define: (_ns: string, make: (base: unknown) => object) => { built = make({ keep: 1 }) as typeof built }
  }
  ;(globalThis as { __crx?: unknown }).__crx = crx
  vi.stubGlobal('navigator', userActivation === undefined ? {} : { userActivation })
  // Run from its own source text, as the library does.
  new Function(`return (${permissionsApi.toString()})`)()()
  return { built, calls }
}

afterEach(() => {
  delete (globalThis as { __crx?: unknown }).__crx
  vi.unstubAllGlobals()
})

describe('permissionsApi', () => {
  it('passes the page\'s user activation as the second argument', async () => {
    const { built, calls } = build({ isActive: true })
    await built['request']?.({ permissions: ['history'] })
    expect(calls).toEqual([{ name: 'permissions.request', args: [{ permissions: ['history'] }, true] }])
  })

  it('passes false when there is no activation, as in a worker', async () => {
    const { built, calls } = build(undefined)
    await built['request']?.({ permissions: ['history'] })
    expect(calls[0]?.args).toEqual([{ permissions: ['history'] }, false])
  })

  it('keeps a trailing callback last', async () => {
    const { built, calls } = build({ isActive: false })
    const callback = (): void => {}
    await built['request']?.({ origins: [] }, callback)
    expect(calls[0]?.args).toEqual([{ origins: [] }, false, callback])
  })

  it('defines the other calls and both events, and keeps what the library had', () => {
    const { built } = build({ isActive: true })
    expect(Object.keys(built).sort()).toEqual(['addHostAccessRequest', 'contains', 'getAll', 'keep', 'onAdded', 'onRemoved', 'remove', 'removeHostAccessRequest', 'request'])
  })
})
