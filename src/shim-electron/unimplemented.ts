// One Proxy-based mechanism backing every "not yet considered" refusal in
// this package, used at both a whole-module grain (`shell`, `clipboard`) and
// a single-method grain (`dialog`'s methods besides `showOpenDialog`) -- see
// README.md's Design notes for why a real ESM namespace cannot be made to
// do this, and what that leaves genuinely total versus merely curated.

import { refuse } from './errors.js'
import type { ElectronShimReason } from './errors.js'

interface Refusal { readonly api: string, readonly reason: ElectronShimReason, readonly message: string }

/**
 * Wraps `known` so every property already on it works exactly as it does
 * today, and any other property throws instead of silently reading as
 * `undefined`. `classify` names the api/reason/message for whatever prop was
 * accessed -- the two call sites below classify differently (a whole member
 * vs. one extra method on an existing object), which is why this stays a
 * parameter rather than a fixed message baked in here.
 */
export function refusingProxy<T extends object> (known: T, classify: (prop: string) => Refusal): T {
  return new Proxy(known, {
    get (target, prop, receiver) {
      if (typeof prop === 'symbol' || Reflect.has(target, prop)) {
        return Reflect.get(target, prop, receiver)
      }
      const { api, reason, message } = classify(prop)
      throw refuse(api, reason, message)
    }
  })
}

/** The 'unimplemented' reason's one wording, shared by every call site below so every such refusal reads the same. */
export function notConsidered (api: string): Refusal {
  return {
    api,
    reason: 'unimplemented',
    message: `Orivon's electron compatibility package does not implement '${api}'; nothing has ` +
      'decided whether it will (compatibility-matrix.md Table 2). This is real Electron surface ' +
      'this package has not yet considered -- distinct from a refusal by design or a feature ' +
      'that is planned but not built yet.'
  }
}

/**
 * A stand-in for a whole Electron module this package does not implement at
 * all (`shell`, `clipboard`, ...). Every property access throws, naming the
 * member and the property together (`shell.openExternal`) -- a porting app
 * almost always reads a method off one of these before calling it, so
 * throwing on the read gives a shorter, more legible stack than waiting for
 * the call.
 */
export function unimplementedMember (api: string): object {
  return refusingProxy({}, (prop) => notConsidered(`${api}.${prop}`))
}

/**
 * Wraps the package's own exported surface for `import electron from
 * 'electron'` / default-style consumption, so a name outside it -- anything
 * this package has never even listed, not just the curated members built
 * with `unimplementedMember` -- throws the same way when read off the
 * default export, instead of resolving to `undefined`. This is the one
 * consumption shape where the refusal is genuinely total rather than
 * limited to a curated list: see README.md for why named exports cannot
 * offer the same guarantee.
 */
export function withUnimplementedFallback<T extends Record<string, unknown>> (known: T): T {
  return refusingProxy(known, notConsidered)
}
