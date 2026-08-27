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
    // Captured BEFORE the install, and compared by identity after. The
    // earlier version of this test only checked that globalThis.process was
    // not the same object as target.process -- which passes even if
    // installGlobals clobbered globalThis with some OTHER object, and never
    // looked at setImmediate/clearImmediate at all.
    const ambient = globalThis as { process?: unknown, setImmediate?: unknown, clearImmediate?: unknown }
    const before = { process: ambient.process, setImmediate: ambient.setImmediate, clearImmediate: ambient.clearImmediate }

    const { target } = install()

    expect(target.process).toBeDefined()
    expect(typeof target.setImmediate).toBe('function')
    expect(typeof target.clearImmediate).toBe('function')

    expect(ambient.process).toBe(before.process)
    expect(ambient.setImmediate).toBe(before.setImmediate)
    expect(ambient.clearImmediate).toBe(before.clearImmediate)
  })

  describe('process surface', () => {
    it('exposes platform as a string that can never collide with a real Node platform', () => {
      const { target } = install()
      // toBeDefined() first: without it this test passes vacuously when
      // process is undefined, because `undefined` is not in the list either.
      expect(target.process).toBeDefined()
      // Not asserting the literal 'browser' value here -- asserting the
      // PROPERTY this value must hold: it must never equal any of Node's
      // own platform names, or an `=== 'win32'`-style check downstream
      // could fire on a wrong guess instead of safely falling through.
      const realPlatforms = ['aix', 'darwin', 'freebsd', 'linux', 'openbsd', 'sunos', 'win32', 'android', 'cygwin', 'netbsd', 'haiku']
      expect(realPlatforms).not.toContain(target.process?.platform)
    })

    // EVIDENCED AGAINST THE REAL CALL GRAPH, not against this file's
    // anticipated surface (src/shim/README.md requirement 1). Grepping the
    // spike's shipped bundles -- the ones that made gates 1a/1b actually
    // pass -- finds `process.browser` read 4 times in gate1a and 6 in
    // gate1b, and the npm `process` polyfill they bundled sets it to true:
    //
    //   bittorrent-tracker (Client AND Server):
    //     if (!process.browser && !opts.port) throw new Error('Option `port` is required')
    //   crypto-browserify checkNative():
    //     if (global.process && !global.process.browser) return Promise.resolve(false)
    //   crypto-browserify default encoding, and webtorrent's FILESYSTEM_CONCURRENCY.
    //
    // Omitting it does NOT fail loudly. It makes each of those quietly take
    // the Node branch -- which is this file's own rule 2 ("louder, not
    // quieter") violated by the shim that exists to enforce it.
    it('sets browser true, so a dependency guarding on !process.browser takes the browser branch', () => {
      const { target } = install()
      // Strictly true, not merely truthy: debug's entry point compares with
      // `process.browser === true`.
      expect(target.process?.browser).toBe(true)
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

    // A TYPE-LEVEL regression test, enforced by `npm run typecheck` rather
    // than at runtime: if ImmediateHandle ever goes back to being
    // `ReturnType<typeof setTimeout>`, tsc resolves that to NodeJS.Timeout
    // (this repo sets `"types": ["node"]` globally), `.unref` becomes a
    // legal property access, and the @ts-expect-error below turns into an
    // "unused directive" error that fails the build.
    //
    // Why that matters: in the sandboxed renderer this shim actually runs
    // in, setTimeout returns a NUMBER, which has no .unref(). Typing the
    // handle as NodeJS.Timeout lets `setImmediate(fn).unref()` compile
    // clean and throw at runtime -- a silent-at-review, loud-at-3am bug of
    // exactly the shape this file exists to prevent.
    it('treats the immediate handle as opaque, exposing no Node Timeout methods', () => {
      const { target } = install()
      const handle = target.setImmediate?.(() => {})

      // The assertion here is the DIRECTIVE, checked by `npm run typecheck`,
      // not anything at runtime: under vitest this executes in Node, where
      // setTimeout really does return a Timeout that has .unref(). The
      // renderer -- where it is a bare number and .unref() throws -- is the
      // host that matters, and no unit test in this process can stand in for
      // it. Keeping the handle opaque in the TYPE is what closes that gap,
      // so the type is what this test pins.
      // @ts-expect-error the handle is opaque; .unref() is not part of its type
      void handle?.unref

      // What a caller may legitimately do with it: hand it straight back.
      expect(handle).toBeDefined()
      if (handle !== undefined) target.clearImmediate?.(handle)
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

    // Node's documented signature has TWO forms:
    //   emitWarning(warning[, type[, code]][, ctor])
    //   emitWarning(warning[, options])            <- options: {type, code, detail}
    // Only the first was handled. Passing the options form assigned the
    // whole object to error.name, which stringifies to '[object Object]' --
    // a warning that arrives unreadable rather than not at all, which is
    // the quiet-failure mode this file is supposed to be free of.
    it('accepts the options-object form and uses its type as the reported name', () => {
      const { target, reportError } = install()

      target.process?.emitWarning('old API', { type: 'DeprecationWarning' })

      const [reported] = reportError.mock.calls[0] as [Error, string]
      expect(reported.name).toBe('DeprecationWarning')
      expect(reported.message).toBe('old API')
    })

    it('carries code and detail from the options object onto the reported error', () => {
      const { target, reportError } = install()

      target.process?.emitWarning('old API', { type: 'DeprecationWarning', code: 'DEP0001', detail: 'use the new one' })

      const [reported] = reportError.mock.calls[0] as [Error & { code?: string, detail?: string }, string]
      expect(reported.code).toBe('DEP0001')
      expect(reported.detail).toBe('use the new one')
    })

    it('accepts the fully positional form, code included', () => {
      const { target, reportError } = install()

      target.process?.emitWarning('old API', 'DeprecationWarning', 'DEP0001')

      const [reported] = reportError.mock.calls[0] as [Error & { code?: string }, string]
      expect(reported.name).toBe('DeprecationWarning')
      expect(reported.code).toBe('DEP0001')
    })

    it('defaults the name to Warning when the options object omits type', () => {
      const { target, reportError } = install()

      target.process?.emitWarning('no type given', { code: 'DEP0002' })

      const [reported] = reportError.mock.calls[0] as [Error, string]
      expect(reported.name).toBe('Warning')
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
