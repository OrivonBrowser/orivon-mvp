import { describe, expect, it, vi } from 'vitest'
import { installGlobals, type GlobalsErrorReporter, type GlobalsTarget } from './globals.js'

// Every test installs onto a throwaway object, never onto the real
// globalThis -- that is the property under test as much as any single
// assertion is: this file must never need `afterEach(() => delete
// globalThis.process)` cleanup, because it never touched globalThis at all.
//
// reportError is typed to GlobalsErrorReporter explicitly (`vi.fn<...>()`,
// not a bare `vi.fn()`) so a future signature change to installGlobals fails
// this file at typecheck, not by tests quietly asserting on the wrong shape.
function install (reportError = vi.fn<GlobalsErrorReporter>()) {
  const target: GlobalsTarget = {}
  installGlobals(target, { reportError })
  return { target, reportError }
}

describe('installGlobals', () => {
  it('writes process, setImmediate and clearImmediate onto the target object, not globalThis', () => {
    const { target } = install()

    expect(target.process).toBeDefined()
    expect(typeof target.setImmediate).toBe('function')
    expect(typeof target.clearImmediate).toBe('function')

    // The real globalThis in this test process (Node, under vitest) is
    // untouched -- no property here was ever assigned to it.
    expect((globalThis as { process?: unknown }).process).not.toBe(target.process)
  })

  describe('process surface', () => {
    it('exposes platform as a string that can never collide with a real Node platform', () => {
      const { target } = install()
      // Not asserting the literal 'browser' value here -- asserting the
      // PROPERTY this value must hold: it must never equal any of Node's
      // own platform names, or an `=== 'win32'`-style check downstream
      // could fire on a wrong guess instead of safely falling through.
      const realPlatforms = ['aix', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32', 'android', 'cygwin', 'netbsd', 'haiku']
      expect(realPlatforms).not.toContain(target.process?.platform)
    })

    it('starts env empty rather than inheriting any ambient environment', () => {
      const { target } = install()
      expect(target.process?.env).toEqual({})
    })

    it('gives env a fresh object per install, so one install cannot see another\'s mutations', () => {
      const first = install()
      const second = install()
      if (first.target.process === undefined || second.target.process === undefined) throw new Error('setup failed')
      first.target.process.env['DEBUG'] = '*'
      expect(second.target.process.env['DEBUG']).toBeUndefined()
    })

    it('does not fabricate a specific Node version', () => {
      const { target } = install()
      expect(target.process?.version).toBe('')
    })
  })

  describe('process.nextTick', () => {
    it('defers the callback past the current synchronous run', async () => {
      const { target } = install()
      const order: string[] = []
      target.process?.nextTick(() => order.push('tick'))
      order.push('sync')
      await Promise.resolve()
      expect(order).toEqual(['sync', 'tick'])
    })

    it('forwards extra arguments to the callback, like real Node', async () => {
      const { target } = install()
      const seen: unknown[] = []
      target.process?.nextTick((a: unknown, b: unknown) => { seen.push(a, b) }, 'x', 42)
      await Promise.resolve()
      expect(seen).toEqual(['x', 42])
    })

    // THE RULE THIS TASK EXISTS FOR.
    //
    // A callback that throws must be OBSERVED, not dropped. The naive
    // `queueMicrotask(() => fn(...args))` polyfill this replaces does not
    // give Node's usual guarantee here -- see the long comment on `nextTick`
    // in globals.ts for what was actually verified about where that
    // exception goes instead. Either way, this shim must not depend on
    // ambient behaviour: reportError is the one channel that must see it.
    it('routes a thrown exception to reportError instead of swallowing it', async () => {
      const { target, reportError } = install()
      const boom = new Error('nextTick callback blew up')

      expect(() => target.process?.nextTick(() => { throw boom })).not.toThrow()
      expect(reportError).not.toHaveBeenCalled() // not yet -- nextTick is deferred

      await Promise.resolve()

      expect(reportError).toHaveBeenCalledExactlyOnceWith(boom, 'nextTick')
    })

    it('still runs a later nextTick callback after an earlier one throws', async () => {
      const { target, reportError } = install()
      const after = vi.fn()

      target.process?.nextTick(() => { throw new Error('first callback blows up') })
      target.process?.nextTick(after)
      await Promise.resolve()

      expect(after).toHaveBeenCalledOnce()
      expect(reportError).toHaveBeenCalledOnce()
    })

    it('reports each throwing callback independently, in order', async () => {
      const { target, reportError } = install()
      const first = new Error('first')
      const second = new Error('second')

      target.process?.nextTick(() => { throw first })
      target.process?.nextTick(() => { throw second })
      await Promise.resolve()

      expect(reportError).toHaveBeenNthCalledWith(1, first, 'nextTick')
      expect(reportError).toHaveBeenNthCalledWith(2, second, 'nextTick')
    })
  })

  describe('setImmediate / clearImmediate', () => {
    // A macrotask, unlike nextTick's microtask -- a real (short) wait is
    // needed, matching this repo's existing async-ordering test style
    // (src/main/registry.test.ts) rather than introducing fake timers.
    const flushMacrotask = async (): Promise<void> => {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }

    it('defers the callback past the current synchronous run', async () => {
      const { target } = install()
      const order: string[] = []
      target.setImmediate?.(() => order.push('immediate'))
      order.push('sync')
      await flushMacrotask()
      expect(order).toEqual(['sync', 'immediate'])
    })

    it('forwards extra arguments to the callback', async () => {
      const { target } = install()
      const seen: unknown[] = []
      target.setImmediate?.((a: unknown, b: unknown) => { seen.push(a, b) }, 'x', 42)
      await flushMacrotask()
      expect(seen).toEqual(['x', 42])
    })

    // Same rule as nextTick, proven independently rather than assumed from
    // nextTick's pass -- handle-contracts.md SSWhat the shim must do, rule 2
    // calls out setImmediate by name, not just "whatever nextTick does".
    it('routes a thrown exception to reportError instead of swallowing it', async () => {
      const { target, reportError } = install()
      const boom = new Error('setImmediate callback blew up')

      expect(() => target.setImmediate?.(() => { throw boom })).not.toThrow()
      expect(reportError).not.toHaveBeenCalled() // not yet -- setImmediate is deferred

      await flushMacrotask()

      expect(reportError).toHaveBeenCalledExactlyOnceWith(boom, 'setImmediate')
    })

    it('still runs a later setImmediate callback after an earlier one throws', async () => {
      const { target, reportError } = install()
      const after = vi.fn()

      target.setImmediate?.(() => { throw new Error('first callback blows up') })
      target.setImmediate?.(after)
      await flushMacrotask()

      expect(after).toHaveBeenCalledOnce()
      expect(reportError).toHaveBeenCalledOnce()
    })

    it('clearImmediate prevents a pending callback from ever running', async () => {
      const { target } = install()
      const callback = vi.fn()

      const handle = target.setImmediate?.(callback)
      expect(handle).toBeDefined()
      if (handle !== undefined) target.clearImmediate?.(handle)

      await flushMacrotask()
      expect(callback).not.toHaveBeenCalled()
    })
  })

  describe('process.emitWarning', () => {
    it('wraps a string warning in an Error and reports it, defaulting the name to Warning', () => {
      const { target, reportError } = install()

      target.process?.emitWarning('deprecated thing')

      expect(reportError).toHaveBeenCalledOnce()
      const [reported, origin] = reportError.mock.calls[0] as [Error, string]
      expect(origin).toBe('warning')
      expect(reported).toBeInstanceOf(Error)
      expect(reported.message).toBe('deprecated thing')
      expect(reported.name).toBe('Warning')
    })

    it('uses the given type as the reported error name', () => {
      const { target, reportError } = install()

      target.process?.emitWarning('old API', 'DeprecationWarning')

      const [reported] = reportError.mock.calls[0] as [Error, string]
      expect(reported.name).toBe('DeprecationWarning')
    })

    it('passes an Error warning through unchanged, ignoring type', () => {
      const { target, reportError } = install()
      const warning = new Error('already an error')
      warning.name = 'CustomWarning'

      target.process?.emitWarning(warning, 'DeprecationWarning')

      expect(reportError).toHaveBeenCalledExactlyOnceWith(warning, 'warning')
      expect(warning.name).toBe('CustomWarning') // untouched, not overwritten by type
    })
  })
})
