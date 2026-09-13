import { afterEach, describe, expect, it, vi } from 'vitest'
import { installDevServeHook, maybeInstallDevServeHook, shouldInstallDevServe } from '../dev-serve.js'

afterEach(() => {
  globalThis.__orivonDevRegisterServing = undefined
})

describe('shouldInstallDevServe', () => {
  it('is true only for the literal flag value true -- mirrors dev-grant.ts\'s shouldInstallDevGrant', () => {
    expect(shouldInstallDevServe(true)).toBe(true)
    expect(shouldInstallDevServe(false)).toBe(false)
    expect(shouldInstallDevServe(undefined)).toBe(false)
  })
})

describe('installDevServeHook', () => {
  it('installs a hook that calls the SAME registerServingFor closure passed in, never a second one', async () => {
    const registerServingFor = vi.fn(async () => {})

    installDevServeHook(registerServingFor)

    expect(globalThis.__orivonDevRegisterServing).toBeTypeOf('function')
    await globalThis.__orivonDevRegisterServing?.('https://app.example')

    expect(registerServingFor).toHaveBeenCalledExactlyOnceWith('https://app.example')
  })
})

describe('maybeInstallDevServeHook', () => {
  it('does not install under a plain vitest run, because the compiled-in flag is absent', () => {
    maybeInstallDevServeHook(vi.fn(async () => {}))

    expect(globalThis.__orivonDevRegisterServing).toBeUndefined()
  })
})
