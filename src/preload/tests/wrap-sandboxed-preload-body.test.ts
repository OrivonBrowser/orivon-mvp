// A regression test for the child-host preload's own dead page.evaluate():
// Electron's sandboxed preload loader runs a preload as the body of a
// function it compiles with `Buffer`, `process` and others already bound as
// that function's own parameters (measured: `vm.compileFunction` throws the
// exact error a real sandboxed launch does for a bundled top-level
// `const`/`let`/`class` of the same name). `shimNodeSpecifiers` resolves a
// package's own `buffer`/`util` request through the shim's `buffer` polyfill
// (module-map.ts's `polyfills/buffer.ts`), which both declares and exports
// `Buffer` -- Rollup inlines that real ES module's own top-level statements
// unwrapped, landing the redeclaration directly in the bundle's own top
// level, where it collides with Electron's own binding of the same name.
//
// `wrapSandboxedPreloadBody`'s own `renderChunk` fixes this generically: a
// nested function scope may shadow an outer parameter freely, so wrapping
// the whole chunk in one more layer of function scope defuses the collision
// for any name a future dependency's own bundle might introduce, not just
// `Buffer`.
import { compileFunction } from 'node:vm'
import { describe, expect, it } from 'vitest'
import { wrapSandboxedPreloadBody } from '../../../electron.vite.config.js'

/** The parameter names Electron's sandboxed preload loader binds before running a preload's own
 * body (measured against a real launch's own stack trace, `runPreloadScript` -> `executeSandboxedPreloadScripts`) --
 * a superset is safe here: matching more of them only makes this check stricter, never looser. */
const SANDBOXED_PRELOAD_PARAMS = ['exports', 'require', 'module', '__filename', '__dirname', 'process', 'Buffer', 'global']

/** A representative fragment of what Rollup actually produces for the child-host preload:
 * `shimNodeSpecifiers`'s own resolution of a package's `buffer` request lands a real, unwrapped
 * top-level `const Buffer = ...` in the bundle -- this is the shape that collides. */
const REDECLARING_CHUNK = "const Buffer = { from () { return null } };\nmodule.exports = { Buffer };\n"

describe('wrapSandboxedPreloadBody', () => {
  it('reproduces the real collision for an unwrapped chunk redeclaring a sandboxed preload\'s own binding', () => {
    expect(() => compileFunction(REDECLARING_CHUNK, SANDBOXED_PRELOAD_PARAMS))
      .toThrow(/Identifier 'Buffer' has already been declared/)
  })

  it('wraps the chunk so a redeclared name only shadows the outer parameter, never collides with it', () => {
    const plugin = wrapSandboxedPreloadBody()
    const rendered = (plugin.renderChunk as (code: string, chunk: unknown, options: unknown) => { code: string, map: null })
      .call({}, REDECLARING_CHUNK, {}, {})
    expect(() => compileFunction(rendered.code, SANDBOXED_PRELOAD_PARAMS)).not.toThrow()
  })

  it('wraps in a self-invoking function, so the chunk still runs as a plain CommonJS module body', () => {
    const plugin = wrapSandboxedPreloadBody()
    const rendered = (plugin.renderChunk as (code: string, chunk: unknown, options: unknown) => { code: string, map: null })
      .call({}, 'module.exports = { ok: true };\n', {}, {})
    const fn = compileFunction(rendered.code, ['exports', 'require', 'module'])
    const moduleObject: { exports: unknown } = { exports: {} }
    fn.call(moduleObject, moduleObject.exports, () => { throw new Error('not used') }, moduleObject)
    expect(moduleObject.exports).toEqual({ ok: true })
  })
})
