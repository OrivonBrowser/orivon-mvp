// The config a session takes in place of `{ mode: 'system' }`: the system's own rules and exceptions, and every name the
// verifier serves added to the exceptions so that no proxy is asked for one. Pure.

import { BUILTIN_ADDRESSES } from '../../../protocols/builtin.js'
import type { SystemProxyConfig } from '../system-follow.js'
import { pacDataUrl, wrapPacScript } from './pac-wrapper.js'
import type { SystemSettings } from './settings-source.js'

/**
 * Only `*.suffix`, the spelling the resolver rules map (`MAP *.suffix`). No rule for the root-dot spelling (`fixture.eth.`): while
 * the resolver rules do not match it, a rule that sent it direct would have Chromium resolve the name itself and let it leave this
 * computer. It stays on the proxy, so the guard refuses it.
 */
export function routedBypassRules (): string[] {
  return BUILTIN_ADDRESSES.routedSuffixes().map((suffix) => `*.${suffix}`)
}

/** What a session is set to for `settings`, or undefined when they are left to `{ mode: 'system' }`: no proxy, detection, or anything that could not be read or carried. A script is `mirroredScriptConfig`'s, once it is fetched. */
export function mirroredConfig (settings: SystemSettings): SystemProxyConfig | undefined {
  if (settings.kind !== 'manual') return undefined
  return { mode: 'fixed_servers', proxyRules: settings.proxyRules, proxyBypassRules: [...settings.exceptions, ...routedBypassRules()].join(';') }
}

/** What a session is set to for the system's proxy script, `text`: a script of Orivon's that answers `DIRECT` for every name the verifier serves before `text` runs. */
export function mirroredScriptConfig (text: string): SystemProxyConfig {
  return { mode: 'pac_script', pacScript: pacDataUrl(wrapPacScript(text, BUILTIN_ADDRESSES.routedSuffixes())) }
}
