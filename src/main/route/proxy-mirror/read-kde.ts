// KDE's proxy settings (the `[Proxy Settings]` section of `kioslaverc`) turned into what the mirror copies, as Chromium's KDE
// reader makes of the same files: every file read is merged key by key, the later one winning; a server is `host port`
// or a URL; each exception is a suffix match; and a line Chromium's reader skips is skipped here too. Pure.

import { isIPv4, isIPv6 } from 'node:net'
import type { SystemSettings } from './settings-source.js'

/** `fgets` into a 512-byte buffer: a line of 511 bytes or more, its newline apart, is skipped whole. */
const MOST_LINE_BYTES = 510
/** A name or an IPv4 address, or a bracketed IPv6 address, then an optional port: nothing that could end or add a rule. */
const SERVER = /^(?<host>[A-Za-z0-9._-]+|\[[0-9A-Fa-f:.]+\])(?::(?<port>\d{1,5}))?$/
/** One exception: it is joined into a list of rules, so it holds no separator or space. */
const EXCEPTION = /^[^\s;,]+$/
const BLANK = /^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g

type Mode = 'none' | 'manual' | 'script' | 'detect' | 'environment'

interface Settings {
  mode?: Mode | undefined
  script: string
  http?: string | undefined
  https?: string | undefined
  socks?: string | undefined
  ignore: string[]
  reversed: boolean
}

const trim = (text: string): string => text.replace(BLANK, '')

/** `base::StringToInt`: a whole decimal number that fits, else `0`. */
function intOf (value: string): number {
  const number = /^[+-]?\d+$/.test(value) ? Number(value) : 0
  return number >= -2_147_483_648 && number <= 2_147_483_647 ? number : 0
}

const MODES: Readonly<Record<number, Mode>> = { 1: 'manual', 2: 'script', 3: 'detect', 4: 'environment' }

/** A server entry, kept for the schemes that have one: an empty entry or `//:` is no proxy, and the first space stands for the colon before the port. */
function serverEntry (value: string): string | undefined {
  if (value === '' || value.startsWith('//:')) return undefined
  const space = value.indexOf(' ')
  return space === -1 ? value : `${value.slice(0, space)}:${value.slice(space + 1)}`
}

function apply (settings: Settings, key: string, value: string): void {
  if (key === 'ProxyType') settings.mode = MODES[intOf(value)] ?? 'none'
  else if (key === 'Proxy Config Script') settings.script = value
  else if (key === 'httpProxy') settings.http = serverEntry(value) ?? settings.http
  else if (key === 'httpsProxy') settings.https = serverEntry(value) ?? settings.https
  else if (key === 'socksProxy') settings.socks = serverEntry(value) ?? settings.socks
  else if (key === 'ReversedException') settings.reversed = value === 'true' || intOf(value) !== 0
  else if (key === 'NoProxyFor') settings.ignore = value.split(/[, ]/).filter((entry) => entry !== '')
}

/** One file, line by line as Chromium reads it. */
function mergeFile (settings: Settings, text: string): void {
  const lines = text.split('\n')
  // Whatever follows the last newline is a line Chromium never finishes reading.
  lines.pop()
  let inSection = false
  for (const line of lines) {
    if (Buffer.byteLength(line) > MOST_LINE_BYTES) continue
    if (line.startsWith('[')) {
      inSection = line.startsWith('[Proxy Settings]')
      continue
    }
    const equals = line.indexOf('=')
    if (!inSection || equals === -1) continue
    let key = trim(line.slice(0, equals))
    if (key.endsWith(']')) {
      // A localised or expanded key, `name[$e]`: the mark is dropped.
      const open = key.lastIndexOf('[')
      if (open === -1) continue
      key = key.slice(0, open).replace(/[ \t\n\v\f\r]+$/, '')
    }
    if (key !== '') apply(settings, key, trim(line.slice(equals + 1)))
  }
}

/** `host[:port]` as `setProxy` reads it, with the scheme, credentials and trailing slash dropped as Chromium drops them, or undefined for a server that cannot be written into a rule. */
function serverOf (entry: string): { readonly address: string, readonly socks4: boolean } | undefined {
  const socks4 = /^socks4:\/\//i.test(entry)
  let rest = entry
  const scheme = rest.indexOf('://')
  if (scheme !== -1) rest = rest.slice(scheme + 3)
  const at = rest.indexOf('@')
  if (at !== -1) rest = rest.slice(at + 1)
  if (rest.endsWith('/')) rest = rest.slice(0, -1)
  const found = SERVER.exec(rest)
  if (found === null) return undefined
  const { host = '', port } = found.groups ?? {}
  if (port !== undefined && (Number(port) === 0 || Number(port) > 65_535)) return undefined
  if (host.startsWith('[') && !isIPv6(host.slice(1, -1))) return undefined
  return { address: rest, socks4 }
}

/**
 * An exception as the system's session reads it. Chromium turns every hostname rule of the list into a suffix match by putting
 * a `*` in front (`.corp.test` is `*.corp.test`, `corp.test` is `*corp.test`); a rule for an address, a block of addresses or
 * `<local>` is left as it is. The list `setProxy` takes gets no such rewrite, so it is done here.
 */
function suffixRule (entry: string): string {
  const scheme = entry.indexOf('://')
  const prefix = scheme === -1 ? '' : entry.slice(0, scheme + 3)
  const rest = scheme === -1 ? entry : entry.slice(scheme + 3)
  const address = rest.replace(/:\d+$/, '')
  const literal = isIPv4(address) || (address.startsWith('[') && address.endsWith(']') && isIPv6(address.slice(1, -1)))
  if (rest === '' || rest.startsWith('*') || rest.startsWith('<') || rest.includes('/') || literal) return entry
  return `${prefix}*${rest}`
}

/** The merged settings of every `kioslaverc` that was opened, lowest priority first, as the settings Chromium would make of them. */
export function parseKdeSettings (files: readonly string[]): SystemSettings {
  const settings: Settings = { script: '', ignore: [], reversed: false }
  for (const text of files) mergeFile(settings, text)
  if (settings.mode === undefined || settings.mode === 'none') return { kind: 'none' }
  if (settings.mode === 'detect') return { kind: 'detect' }
  if (settings.mode === 'script') return { kind: settings.script === '' ? 'detect' : 'script' }
  if (settings.mode === 'environment') return { kind: 'unsupported' }
  const rules: string[] = []
  for (const [scheme, entry] of [['http', settings.http], ['https', settings.https], ['socks', settings.socks]] as const) {
    if (entry === undefined) continue
    const server = serverOf(entry)
    if (server === undefined) return { kind: 'unsupported' }
    rules.push(scheme === 'socks' ? `socks=${server.socks4 ? 'socks4' : 'socks5'}://${server.address}` : `${scheme}=${server.address}`)
  }
  if (rules.length === 0) return { kind: 'none' }
  if (settings.reversed || !settings.ignore.every((entry) => EXCEPTION.test(entry))) return { kind: 'unsupported' }
  return { kind: 'manual', proxyRules: rules.join(';'), exceptions: settings.ignore.map(suffixRule) }
}
