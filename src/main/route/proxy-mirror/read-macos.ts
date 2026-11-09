// macOS's proxy settings as `scutil --proxy` prints them, turned into what the mirror copies. It follows what Chromium's macOS
// reader makes of the same dictionary (`SCDynamicStoreCopyProxies`): the top level only, a server counts when its `Enable` flag is
// non-zero and it names a host, the HTTPS server is an HTTP proxy for `https:` addresses, and the SOCKS server is SOCKS5. Only the
// keys it needs are read, so nothing a dictionary holds beyond them reaches anything. See README.md's Design notes for what was
// measured. Pure.

import type { SystemSettings } from './settings-source.js'

/** A name, an IPv4 address or an IPv6 address: nothing that could end or add a rule. */
const HOST = /^(?:[A-Za-z0-9._-]+|[0-9A-Fa-f:.]*:[0-9A-Fa-f:.]*)$/
const OPENS = /^(\S+) : <(dictionary|array)> \{$/
const ENTRY = /^(\S+) :(?: (.*))?$/
/** The address macOS gives a script when it is asked to find its proxy by looking for one: detection, not a script of the person's. */
const DISCOVERY_SCRIPT = 'http://wpad/wpad.dat'

interface Dictionary {
  readonly values: ReadonlyMap<string, string>
  /** `ExceptionsList`, in order; empty when the dictionary has none. */
  readonly exceptions: readonly string[]
  /** A list item took more than one line, so the list is not what Chromium read. */
  readonly splitItem: boolean
}

/**
 * The top-level keys of the dictionary `scutil --proxy` prints, and the items of its `ExceptionsList`. Below `__SCOPED__` sits
 * each network interface's own copy of the same keys, which Chromium never reads. Undefined for text that is no dictionary or does
 * not close.
 */
function topLevel (output: string): Dictionary | undefined {
  const values = new Map<string, string>()
  const exceptions: string[] = []
  let depth = 0
  let listing = false
  let splitItem = false
  for (const raw of output.split('\n')) {
    const line = raw.trim()
    if (depth === 0) {
      if (line === '<dictionary> {') depth = 1
      continue
    }
    if (line === '}') {
      depth -= 1
      if (depth === 1) listing = false
      if (depth === 0) return values.size === 0 ? undefined : { values, exceptions, splitItem }
      continue
    }
    const opened = OPENS.exec(line)
    if (opened !== null) {
      if (depth === 1 && opened[1] === 'ExceptionsList' && opened[2] === 'array') listing = true
      depth += 1
      continue
    }
    const entry = ENTRY.exec(line)
    if (entry === null) {
      if (listing && depth === 2) splitItem = true
      continue
    }
    const [, key, value] = entry as unknown as [string, string, string | undefined]
    if (depth === 1) values.set(key, value ?? '')
    else if (depth === 2 && listing) exceptions.push(value ?? '')
  }
  return undefined
}

/** `host` or `host:port` as a rule spells it, or undefined for a server that cannot be written into one. A port that is not there is the scheme's default, as Chromium takes it. */
function address (host: string, port: string | undefined): string | undefined {
  if (!HOST.test(host)) return undefined
  const shown = host.includes(':') ? `[${host}]` : host
  if (port === undefined) return shown
  if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65_535) return undefined
  return `${shown}:${port}`
}

/** What `scutil --proxy` printed, as the settings Chromium would make of them. */
export function parseMacosSettings (output: string): SystemSettings {
  const dictionary = topLevel(output)
  if (dictionary === undefined) return { kind: 'unreadable' }
  if (dictionary.splitItem) return { kind: 'unsupported' }
  const { values } = dictionary
  const on = (name: string): boolean => {
    const value = values.get(name)
    return value !== undefined && /^-?\d+$/.test(value) && Number(value) !== 0
  }
  const scriptUrl = (values.get('ProxyAutoConfigURLString') ?? '').trim()
  const discovering = on('ProxyAutoDiscoveryEnable')
  if (on('ProxyAutoConfigEnable') && scriptUrl !== '' && !(discovering && scriptUrl.toLowerCase() === DISCOVERY_SCRIPT)) return { kind: 'script' }
  const rules: string[] = []
  for (const [scheme, prefix] of [['http', 'HTTP'], ['https', 'HTTPS'], ['socks', 'SOCKS']] as const) {
    const host = values.get(`${prefix}Proxy`)
    if (!on(`${prefix}Enable`) || host === undefined || host === '') continue
    const one = address(host, values.get(`${prefix}Port`))
    if (one === undefined) return { kind: 'unsupported' }
    rules.push(scheme === 'socks' ? `socks=socks5://${one}` : `${scheme}=${one}`)
  }
  if (rules.length === 0) return { kind: discovering ? 'detect' : 'none' }
  const listed = dictionary.exceptions.map((entry) => entry.trim()).filter((entry) => entry !== '')
  return { kind: 'manual', proxyRules: rules.join(';'), exceptions: on('ExcludeSimpleHostnames') ? ['<local>', ...listed] : listed }
}
