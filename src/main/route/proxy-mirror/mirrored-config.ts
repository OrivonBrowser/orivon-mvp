// The config a session takes in place of `{ mode: 'system' }`: the system's own rules and exceptions, and every name the
// verifier serves added to the exceptions so that no proxy is asked for one. Pure.

import { BUILTIN_ADDRESSES } from '../../../protocols/builtin.js'
import type { SystemProxyConfig } from '../system-follow.js'
import type { SystemSettings } from './settings-source.js'

/**
 * Only `*.suffix`, the spelling the resolver rules map (`MAP *.suffix`). No rule for the root-dot spelling (`fixture.eth.`): while
 * the resolver rules do not match it, a rule that sent it direct would have Chromium resolve the name itself and let it leave this
 * computer. It stays on the proxy, so the guard refuses it.
 */
export function routedBypassRules (): string[] {
  return BUILTIN_ADDRESSES.routedSuffixes().map((suffix) => `*.${suffix}`)
}

/** What a session is set to for `settings`, or undefined when they are left to `{ mode: 'system' }`: no proxy, a script, detection, or anything that could not be read or carried. */
export function mirroredConfig (settings: SystemSettings): SystemProxyConfig | undefined {
  if (settings.kind !== 'manual') return undefined
  return { mode: 'fixed_servers', proxyRules: settings.proxyRules, proxyBypassRules: [...settings.exceptions, ...routedBypassRules()].join(';') }
}
