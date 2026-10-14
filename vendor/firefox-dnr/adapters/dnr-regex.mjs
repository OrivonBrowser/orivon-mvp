/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Adapter replacing the JavaScript `RegExp` that ExtensionDNR.sys.mjs builds
// for `condition.regexFilter` (see vendor/firefox-dnr/UPSTREAM.md patch 18).
// Chrome matches `regexFilter` with RE2, which runs in time linear in the
// URL; the JavaScript engine backtracks, and the engine here evaluates
// every request on the main thread. `re2js` (a pure JavaScript port of RE2,
// no native code) gives the same guarantee and the same dialect: a pattern
// RE2 does not accept (a backreference, a lookaround) is refused, as
// Chrome refuses it.

import { RE2JS } from 're2js'

/** Chrome's cap on a `regexFilter`. */
export const MAX_REGEX_FILTER_LENGTH = 2048

/** The two calls the engine makes of a compiled filter. */
class CompiledRegexFilter {
  #pattern

  constructor(pattern) {
    this.#pattern = pattern
  }

  /** Whether the pattern matches anywhere in `input`, in time linear in it. */
  test(input) {
    return this.#pattern.test(input)
  }

  /** The first match as a `RegExp.prototype.exec`-shaped array (index 0 the
   * whole match, then each group, `undefined` for a group that did not
   * take part), or `null`. */
  exec(input) {
    const matcher = this.#pattern.matcher(input)
    if (!matcher.find()) return null
    const result = []
    for (let group = 0; group <= matcher.groupCount(); group++) {
      result.push(matcher.group(group) ?? undefined)
    }
    return result
  }
}

/**
 * Compiles `regexFilter` the way the validator and `isRegexSupported` both
 * need it. Throws an `Error` with a `kind` of `'complexity'` (too long) or
 * `'syntax'` (RE2 does not accept it) and Chrome-style text.
 *
 * @param {string} regexFilter
 * @param {boolean | undefined} isUrlFilterCaseSensitive
 */
export function compileRegexFilter(regexFilter, isUrlFilterCaseSensitive) {
  if (regexFilter.length > MAX_REGEX_FILTER_LENGTH) {
    throw Object.assign(
      new Error(`regexFilter is longer than ${String(MAX_REGEX_FILTER_LENGTH)} characters`),
      { kind: 'complexity' }
    )
  }
  try {
    const flags = isUrlFilterCaseSensitive ? 0 : RE2JS.CASE_INSENSITIVE
    return new CompiledRegexFilter(RE2JS.compile(regexFilter, flags))
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw Object.assign(new Error(`regexFilter is not a valid regular expression: ${reason}`), { kind: 'syntax' })
  }
}

/**
 * Why `regexFilter` cannot be used, or `null` when it can.
 *
 * @param {string} regexFilter
 * @param {boolean | undefined} isUrlFilterCaseSensitive
 * @returns {{ kind: 'syntax' | 'complexity', message: string } | null}
 */
export function regexFilterProblem(regexFilter, isUrlFilterCaseSensitive) {
  try {
    compileRegexFilter(regexFilter, isUrlFilterCaseSensitive)
    return null
  } catch (error) {
    return { kind: error.kind, message: error.message }
  }
}
