// The config a session takes in place of `{ mode: 'system' }`: the system's own rules and exceptions, and every name the
// verifier serves added to the exceptions so that no proxy is asked for one. Pure.

import { BUILTIN_ADDRESSES } from '../../../protocols/builtin.js'
import type { SystemProxyConfig } from '../system-follow.js'
import type { SystemSettings } from './settings-source.js'

/** A bypass rule matches `fixture.eth` and not `fixture.eth.`, the root-dot spelling, which is a host of its own to it: each suffix needs both. */
export function routedBypassRules (): string[] {
  return BUILTIN_ADDRESSES.routedSuffixes().flatMap((suffix) => [`*.${suffix}`, `*.${suffix}.`])
}

/** What a session is set to for `settings`, or undefined when they are left to `{ mode: 'system' }`: no proxy, a script, detection, or anything that could not be read or carried. */
export function mirroredConfig (settings: SystemSettings): SystemProxyConfig | undefined {
  if (settings.kind !== 'manual') return undefined
  return { mode: 'fixed_servers', proxyRules: settings.proxyRules, proxyBypassRules: [...settings.exceptions, ...routedBypassRules()].join(';') }
}
