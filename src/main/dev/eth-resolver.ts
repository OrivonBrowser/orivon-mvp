// Developer-mode DNS override for orivon-ports' fake `.eth` names (that
// repository's docs/recipe-format.md `eth` field -- never real ENS, no
// trustless resolution exists yet, README.md's own "No ENS, no IPFS" line).
// This process has no other connection to orivon-ports: it is told where
// that repository's `orivon-port names` wrote its name->port map through
// ORIVON_ETH_NAMES_FILE, and does nothing at all if that variable, or
// ORIVON_DEV_ORIGINS=1, is unset -- which is every run that is not
// demonstrating this one feature.
//
// --host-resolver-rules, not --proxy-pac-url: verified against a real
// Electron 44 window before this file was written. Both the default session
// and a `session.fromPartition` one honoured a process-wide
// --host-resolver-rules switch identically, including the exact port a
// MAP clause named; a `file://` --proxy-pac-url did not take effect at all
// in the same build, silently falling through to ordinary DNS. No PAC is
// generated or read here as a result. orivon-ports' own `generatePac` stays
// available for whatever future consumer needs one -- this shell is not it.

import { readFileSync } from 'node:fs'
import { app } from 'electron'
import type { Subsystem } from '../registry.js'

/** One lowercase label plus `.eth` -- the same shape orivon-ports' recipe.ts validates. Re-checked here because this file reads a name from OUTSIDE this process and is about to splice it into a command-line switch; that file's own validation is not a guarantee this one may skip. */
const ETH_NAME = /^[a-z0-9][a-z0-9-]*\.eth$/
const MIN_PORT = 1
const MAX_PORT = 65535

/**
 * The entries of a names file this process is willing to act on. An entry
 * whose key is not a plain `.eth` name, or whose value is not a valid port
 * number, is DROPPED rather than passed through -- both callers below
 * splice their output into a command-line switch, which is the one place a
 * malformed or hostile names file stops being just bad data and becomes an
 * argument-injection surface. One pass, so a name can never be accepted by
 * one switch and rejected by the other.
 */
function validEntries (names: Readonly<Record<string, unknown>>): Array<[string, number]> {
  const entries: Array<[string, number]> = []
  for (const [name, port] of Object.entries(names)) {
    if (!ETH_NAME.test(name)) continue
    if (typeof port !== 'number' || !Number.isInteger(port) || port < MIN_PORT || port > MAX_PORT) continue
    entries.push([name, port])
  }
  return entries
}

/**
 * `{ "freetube.eth": 8875, ... }` to a `--host-resolver-rules` value, one
 * `MAP` clause per accepted name.
 */
export function buildHostResolverRules (names: Readonly<Record<string, unknown>>): string {
  return validEntries(names).map(([name, port]) => `MAP ${name} 127.0.0.1:${String(port)}`).join(',')
}

/**
 * The same accepted names as an `--unsafely-treat-insecure-origin-as-secure`
 * value, so a dev `.eth` tab is a SECURE CONTEXT.
 *
 * Without it the page's origin is plain `http:` on a non-loopback host,
 * which Chromium does not treat as potentially trustworthy however the name
 * resolves -- so `navigator.clipboard`, `crypto.subtle`,
 * `crypto.randomUUID` and service workers are all simply absent, and an app
 * opened by its `.eth` name is a different app from the same bundle opened
 * at `127.0.0.1`, which Chromium does exempt. An INSTALLED app never needs
 * this: its origin is really `https:` (ADR-0007), and only this dev-mode
 * path can reach the mismatch.
 *
 * Verified against a real Electron 44 window, the same standard
 * `--host-resolver-rules` above was held to: the switch takes effect on its
 * own, with no `--enable-features=OverrideSecurityRestrictionsOnInsecureOrigin`
 * alongside it.
 */
export function buildSecureOriginList (names: Readonly<Record<string, unknown>>): string {
  return validEntries(names).map(([name]) => `http://${name}`).join(',')
}

/** Same flag dev-app-origin.ts reads -- one switch turns on both halves of the fake-name path: resolution here, the grant there. Read per call, not at module scope, so a test can set it per case. */
function devModeEnabled (): boolean {
  return process.env['ORIVON_DEV_ORIGINS'] === '1'
}

/**
 * Registered UNCONDITIONALLY in subsystems.ts, the same as `dev-grant.ts`'s
 * own subsystem -- the conditional lives here. Never `critical`: this is a
 * dev convenience layered on top of the capability boundary, not the
 * boundary itself, so a broken or missing names file is reported once,
 * loudly, and changes nothing else about how the shell starts.
 */
export const ethResolverSubsystem: Subsystem = {
  name: 'eth-resolver',
  beforeReady: () => {
    if (!devModeEnabled()) return
    const path = process.env['ORIVON_ETH_NAMES_FILE']
    if (path === undefined) return

    let rules: string
    let secureOrigins: string
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
        throw new Error('expected a JSON object of "name.eth": port')
      }
      rules = buildHostResolverRules(parsed as Record<string, unknown>)
      secureOrigins = buildSecureOriginList(parsed as Record<string, unknown>)
    } catch (error) {
      console.error(`[orivon] ORIVON_ETH_NAMES_FILE (${path}) could not be read as a names map:`, error)
      return
    }

    if (rules === '') return
    app.commandLine.appendSwitch('host-resolver-rules', rules)
    // Both switches, or neither: a name dropped from the MAP clauses is not
    // declared trustworthy either, which is why both read the same pass.
    app.commandLine.appendSwitch('unsafely-treat-insecure-origin-as-secure', secureOrigins)
    console.error(`[orivon] fake .eth names active (ORIVON_DEV_ORIGINS=1): ${rules}`)
  }
}
