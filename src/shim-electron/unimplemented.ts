// One Proxy-based mechanism backing every "not yet considered" refusal in
// this package, used at both a whole-module grain (`shell`, `clipboard`) and
// a single-method grain (`dialog`'s methods besides `showOpenDialog`) -- see
// README.md's Design notes for why a real ESM namespace cannot be made to
// do this, and what that leaves genuinely total versus merely curated.
//
// `refusingProxy` itself is generic on purpose (A135): `classify` returns
// the Error to throw directly, rather than a record this file used to
// convert via a hardcoded `refuse()` call, so `src/shim/` can reuse this
// exact function with its own `OrivonShimError`/`ShimRefusalReason` without
// this package knowing that caller exists. See `src/shim/unimplemented.ts`
// for why that reuse happens via a direct import rather than `src/shared/`.

import { refuse } from './errors.js'
import type { ElectronShimError } from './errors.js'

/**
 * Wraps `known` so every property already on it works exactly as it does
 * today. Any OTHER property no longer throws on the read itself (A169) --
 * it returns a function (named after the prop, for a legible stack) whose
 * body is `classify(prop)`'s Error, so `typeof`/optional-chaining/
 * destructuring/`in` all see the same thing real Node shows for a member
 * that genuinely does not exist, and only an actual CALL still refuses by
 * name. `classify` returns the Error to throw for whatever prop was
 * accessed -- the call sites below classify differently (a whole member vs.
 * one extra method on an existing object), which is why this stays a
 * parameter rather than a fixed message baked in here.
 */
export function refusingProxy<T extends object> (known: T, classify: (prop: string) => Error): T {
  return new Proxy(known, {
    get (target, prop, receiver) {
      if (typeof prop === 'symbol' || Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver)
      }
      return refusingFunction(prop, classify)
    }
  })
}

/**
 * The value `refusingProxy`'s `get` trap returns for a prop nothing backs.
 * Reading it is inert -- `typeof` sees a function (matching real Node, which
 * really does have most of this surface as callable), and optional
 * chaining/destructuring never trip over it -- so a defensive
 * feature-detection check is never fooled into crashing on the mere read.
 * Only calling it does what #186/A135 built this whole mechanism for.
 */
function refusingFunction (prop: string, classify: (prop: string) => Error): (...args: readonly unknown[]) => never {
  const fn = (..._args: readonly unknown[]): never => { throw classify(prop) }
  Object.defineProperty(fn, 'name', { value: prop, configurable: true })
  return fn
}

/** The 'unimplemented' reason's one wording, shared by every call site below so every such refusal reads the same. */
export function notConsidered (api: string): ElectronShimError {
  return refuse(
    api,
    'unimplemented',
    `Orivon's electron compatibility package does not implement '${api}'; nothing has ` +
      'decided whether it will (compatibility-matrix.md Table 2). This is real Electron surface ' +
      'this package has not yet considered -- distinct from a refusal by design or a feature ' +
      'that is planned but not built yet.'
  )
}

/**
 * A stand-in for a whole Electron module this package does not implement at
 * all (`shell`, `clipboard`, ...). Every property call throws, naming the
 * member and the property together (`shell.openExternal`) -- reading one
 * first, the way a porting app's own defensive check does, stays safe (A169).
 */
export function unimplementedMember (api: string): object {
  return refusingProxy({}, (prop) => notConsidered(`${api}.${prop}`))
}

/**
 * Wraps the package's own exported surface for `import electron from
 * 'electron'` / default-style consumption, so a name outside it -- anything
 * this package has never even listed, not just the curated members built
 * with `unimplementedMember` -- refuses the same way when called off the
 * default export, instead of resolving to `undefined`. This is the one
 * consumption shape where the refusal is genuinely total rather than
 * limited to a curated list: see README.md for why named exports cannot
 * offer the same guarantee.
 */
export function withUnimplementedFallback<T extends Record<string, unknown>> (known: T): T {
  return refusingProxy(known, notConsidered)
}
