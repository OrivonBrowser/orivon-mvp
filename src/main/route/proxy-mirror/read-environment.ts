// The environment's `auto_proxy`, as Chromium's environment reader takes it. The manual variables (`http_proxy` and the like) are
// not read: `no_proxy` already leaves the names the verifier serves out of them. Pure.

import type { SystemSettings } from './settings-source.js'

type Environment = Readonly<Record<string, string | undefined>>

/** Chromium's `Environment::GetVar`: the name as written, else its upper-case spelling. A variable that is set and empty is set, and shadows the other spelling. */
function variable (env: Environment, name: string): string | undefined {
  return env[name] ?? env[name.toUpperCase()]
}

/**
 * What `auto_proxy` comes to, or undefined when it is not set (Chromium then reads the manual variables, which the mirror leaves to the system).
 * Set and empty is automatic detection. Anything else is the address of a script when Chromium can parse it as one, else no proxy:
 * a path or an address with no scheme gives a configuration with nothing in it, and a request goes direct.
 */
export function environmentSettings (env: Environment): SystemSettings | undefined {
  const value = variable(env, 'auto_proxy')
  if (value === undefined) return undefined
  if (value === '') return { kind: 'detect' }
  return URL.canParse(value) ? { kind: 'script', url: value } : { kind: 'none' }
}

/** A reader for `environmentSettings`, or undefined when the environment names none, which leaves nothing to poll. The environment cannot change in a running process, so it is read once. */
export function environmentReader (env: Environment): (() => Promise<SystemSettings>) | undefined {
  const settings = environmentSettings(env)
  return settings === undefined ? undefined : () => Promise.resolve(settings)
}
