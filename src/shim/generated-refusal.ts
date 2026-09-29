// The named-export counterpart to unimplemented.ts's refusingProxy (A287).
// The proxy only refuses a member read off a module's DEFAULT export; a
// bundler that hands a CommonJS `require()` the module's ESM namespace
// instead (esbuild's interop) never goes through that proxy at all, so an
// unbuilt member reads as plain `undefined`. Each generated/*.ts file below
// a module target calls this once per Node member missing from that module's
// own named exports, giving the namespace a matching named stand-in.

/**
 * A function whose only job is to throw `classify(memberName)` -- named
 * after `memberName` (a legible stack, and `fn.name` reads right under
 * `typeof`) so a namespace caller sees the same shape real Node exports for
 * almost this whole surface: a callable. A `function`, never an arrow, for
 * the same reason unimplemented.ts's own stand-in is one: `new
 * os.SomeClass()` must hit this throw, not a bare "not a constructor".
 */
export function refusingExport (memberName: string, classify: (prop: string) => Error): (...args: readonly unknown[]) => never {
  const fn = function (): never { throw classify(memberName) }
  Object.defineProperty(fn, 'name', { value: memberName, configurable: true })
  return fn
}
