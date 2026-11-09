// GNOME's proxy settings (`org.gnome.system.proxy`) as `gsettings list-recursively` prints them, turned into what the
// mirror copies. It follows what Chromium's GSettings reader makes of the same keys: the `http`, `https` and `socks`
// servers are separate (`use-same-proxy` and each server's `enabled` are not read), a server with an empty host is
// unset, and a port of 0 is the scheme's default. Only the keys it needs are read, so an `authentication-password`
// line cannot reach anything. Pure.

import type { SystemSettings } from './settings-source.js'

/** A name, an IPv4 address or an IPv6 address: nothing that could end or add a rule. */
const HOST = /^(?:[A-Za-z0-9._-]+|[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*)$/
/** One entry of the exceptions list: it is joined into a list of rules, so it holds no separator or space. */
const EXCEPTION = /^[^\s;,]+$/
const LINE = /^org\.gnome\.system\.proxy(?:\.([a-z]+))? (\S+) (.*)$/

const ESCAPES: Readonly<Record<string, string>> = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' }

/** One GVariant string literal at the start of `text`, and the rest after it. */
function takeString (text: string): { readonly value: string, readonly rest: string } | undefined {
  const quote = text[0]
  if (quote !== "'" && quote !== '"') return undefined
  let value = ''
  for (let at = 1; at < text.length; at += 1) {
    const char = text[at] as string
    if (char === quote) return { value, rest: text.slice(at + 1) }
    if (char === '\\') {
      at += 1
      value += ESCAPES[text[at] ?? ''] ?? text[at] ?? ''
    } else {
      value += char
    }
  }
  return undefined
}

function stringOf (text: string): string | undefined {
  const taken = takeString(text.trim())
  return taken?.rest.trim() === '' ? taken.value : undefined
}

/** A list of strings, `['a', 'b']`, or the empty list however it is typed (`@as []`). */
function listOf (text: string): string[] | undefined {
  let rest = text.trim().replace(/^@as\s*/, '')
  if (!rest.startsWith('[')) return undefined
  rest = rest.slice(1).trimStart()
  const items: string[] = []
  while (!rest.startsWith(']')) {
    const taken = takeString(rest)
    if (taken === undefined) return undefined
    items.push(taken.value)
    rest = taken.rest.trimStart()
    if (rest.startsWith(',')) rest = rest.slice(1).trimStart()
    else if (!rest.startsWith(']')) return undefined
  }
  return rest.slice(1).trim() === '' ? items : undefined
}

function portOf (text: string): number | undefined {
  const digits = text.trim().replace(/^(?:u?int(?:16|32|64)|byte)\s+/, '')
  return /^\d{1,5}$/.test(digits) && Number(digits) <= 65_535 ? Number(digits) : undefined
}

interface Server {
  host?: string | undefined
  port?: number | undefined
}

/** A bare IPv6 literal is bracketed, the way a rule spells it; every other entry is kept as it is. */
function exceptionRule (entry: string): string {
  return entry.includes(':') && !entry.includes('[') && !entry.includes('/') && entry.indexOf(':') !== entry.lastIndexOf(':') ? `[${entry}]` : entry
}

/** `host:port` as `setProxy` reads it, or undefined for a server that cannot be written into a rule: a host with a character of a separator, a port that did not read. */
function address (host: string, port: number | undefined): string | undefined {
  if (!HOST.test(host) || port === undefined) return undefined
  const shown = host.includes(':') ? `[${host}]` : host
  return port === 0 ? shown : `${shown}:${String(port)}`
}

/** What `gsettings list-recursively org.gnome.system.proxy` printed, as the settings Chromium would make of them. */
export function parseGnomeSettings (output: string): SystemSettings {
  const servers: Record<string, Server> = {}
  let mode: string | undefined
  let script = ''
  let ignore: string[] | undefined = []
  for (const line of output.split('\n')) {
    const found = LINE.exec(line.trim())
    if (found === null) continue
    const [, child, key, value] = found as unknown as [string, string | undefined, string, string]
    if (child === undefined) {
      if (key === 'mode') mode = stringOf(value)
      else if (key === 'autoconfig-url') script = stringOf(value) ?? ''
      else if (key === 'ignore-hosts') ignore = listOf(value)
    } else if (child === 'http' || child === 'https' || child === 'socks') {
      const server = servers[child] ?? {}
      servers[child] = server
      if (key === 'host') server.host = stringOf(value)
      else if (key === 'port') server.port = portOf(value)
    }
  }
  if (mode === undefined) return { kind: 'unreadable' }
  if (mode === 'none') return { kind: 'none' }
  if (mode === 'auto') return { kind: script.trim() === '' ? 'detect' : 'script' }
  if (mode !== 'manual' || ignore === undefined) return { kind: 'unsupported' }
  const rules: string[] = []
  for (const scheme of ['http', 'https', 'socks'] as const) {
    const server = servers[scheme]
    if (server?.host === undefined || server.host === '') continue
    const one = address(server.host, server.port)
    if (one === undefined) return { kind: 'unsupported' }
    rules.push(scheme === 'socks' ? `socks=socks5://${one}` : `${scheme}=${one}`)
  }
  if (rules.length === 0) return { kind: 'none' }
  const exceptions = ignore.filter((entry) => entry.trim() !== '')
  if (!exceptions.every((entry) => EXCEPTION.test(entry))) return { kind: 'unsupported' }
  return { kind: 'manual', proxyRules: rules.join(';'), exceptions: exceptions.map(exceptionRule) }
}
