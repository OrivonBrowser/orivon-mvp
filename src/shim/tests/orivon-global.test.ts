// getOrivon()'s own override: worker/host.ts's createChildHost calls
// setOrivon() once, so a spawnSync served on the child host (whose own
// orivon is deliberately kept off globalThis, preload/child-host.ts's own
// header) can still start a LOCAL child's Worker through child-process/
// spawn.ts's launchChild, which calls getOrivon() unconditionally. Without
// this override, that call throws "window.orivon is not present" for every
// such nested spawn -- measured against a real e2e run before this fix.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { Orivon } from '../../contracts/capability-api.js'
import { getOrivon, setOrivon } from '../orivon-global.js'

const globals = globalThis as { orivon?: Orivon }

describe('getOrivon', () => {
  const original = globals.orivon

  beforeEach(() => {
    delete globals.orivon
  })

  afterEach(() => {
    setOrivon(undefined as unknown as Orivon)
    if (original === undefined) delete globals.orivon
    else globals.orivon = original
  })

  it('throws its own named error when neither globalThis.orivon nor an override is set', () => {
    expect(() => getOrivon()).toThrow(/orivon-node-shim: window\.orivon is not present/)
  })

  it('reads globalThis.orivon when no override was set (an ordinary page)', () => {
    const page = {} as Orivon
    globals.orivon = page
    expect(getOrivon()).toBe(page)
  })

  it('returns the override once setOrivon() was called, even with no globalThis.orivon at all (the child host)', () => {
    const host = {} as Orivon
    setOrivon(host)
    expect(getOrivon()).toBe(host)
  })

  it('prefers the override over globalThis.orivon when, implausibly, both are set', () => {
    const page = {} as Orivon
    const host = {} as Orivon
    globals.orivon = page
    setOrivon(host)
    expect(getOrivon()).toBe(host)
  })
})
