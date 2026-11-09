// The config a session takes in place of `{ mode: 'system' }`: the system's own rules and exceptions, and every name the
// verifier serves, in both spellings, added to the exceptions so that no proxy is asked for one. Pure.

import { routedBypassRules } from '../verifier-name-guard.js'
import type { SystemProxyConfig } from '../system-follow.js'
import type { SystemSettings } from './settings-source.js'

/** What a session is set to for `settings`, or undefined when they are left to `{ mode: 'system' }`: no proxy, a script, detection, or anything that could not be read or carried. */
export function mirroredConfig (settings: SystemSettings): SystemProxyConfig | undefined {
  if (settings.kind !== 'manual') return undefined
  return { mode: 'fixed_servers', proxyRules: settings.proxyRules, proxyBypassRules: [...settings.exceptions, ...routedBypassRules()].join(';') }
}
