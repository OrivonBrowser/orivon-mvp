// The address as the bar shows it while it is not being edited: the site's name in one tone and everything
// else in a quieter one. Pure string work; the input keeps the real value, so nothing here is ever submitted.

export type AddressTone = 'strong' | 'dim'
export interface AddressPart {
  readonly text: string
  readonly tone: AddressTone
  /** The site's own name: the one part the display never shortens, so a long subdomain or path cannot push it out of view. */
  readonly fixed?: true
}

/** Enough for any address a person can read in one line; the display ellipsises further. */
const MAX_SHOWN = 512
const ADDRESS = /^([A-Za-z][A-Za-z0-9+.-]*):\/\/([^/?#]*)([\s\S]*)$/
const SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac'])

interface Authority { readonly host: string, readonly port: string }

/** The host without userinfo, and the port with its colon kept apart. */
function splitAuthority (authority: string): Authority {
  const at = authority.lastIndexOf('@')
  const hostPort = at === -1 ? authority : authority.slice(at + 1)
  const bracket = hostPort.startsWith('[') ? hostPort.indexOf(']') : -1
  const colon = bracket === -1 ? hostPort.lastIndexOf(':') : hostPort.indexOf(':', bracket)
  return colon === -1 ? { host: hostPort, port: '' } : { host: hostPort.slice(0, colon), port: hostPort.slice(colon) }
}

/** How many trailing labels are the site's own name: two, or three under `co.uk` and its kind. Cosmetic only: the
 * display keeps the whole of this part in view and shortens what comes before it, so a wrong guess shifts a tone and
 * what is shortened first, nothing more. */
function registrableLabels (labels: readonly string[]): number {
  if (labels.length <= 2) return labels.length
  const top = labels[labels.length - 1] ?? ''
  const second = labels[labels.length - 2] ?? ''
  return SECOND_LEVEL.has(second) && top.length === 2 ? 3 : 2
}

function hostParts (host: string): AddressPart[] {
  if (host === '') return []
  if (host.startsWith('[') || /^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return [{ text: host, tone: 'strong', fixed: true }]
  const labels = host.split('.')
  const own = registrableLabels(labels)
  const before = labels.slice(0, labels.length - own)
  const parts: AddressPart[] = []
  if (before.length > 0) parts.push({ text: `${before.join('.')}.`, tone: 'dim' })
  parts.push({ text: labels.slice(labels.length - own).join('.'), tone: 'strong', fixed: true })
  return parts
}

/** Merges neighbours of one tone and cuts the total, so the DOM stays small whatever the page put in its URL. */
function tidy (parts: readonly AddressPart[]): AddressPart[] {
  const out: AddressPart[] = []
  let room = MAX_SHOWN
  for (const part of parts) {
    if (part.text === '' || room <= 0) continue
    const text = part.text.length > room ? part.text.slice(0, room) : part.text
    room -= text.length
    const last = out[out.length - 1]
    if (last?.tone === part.tone && last.fixed === part.fixed) out[out.length - 1] = { text: last.text + text, tone: part.tone, ...(part.fixed === true ? { fixed: true as const } : {}) }
    else out.push({ text, tone: part.tone, ...(part.fixed === true ? { fixed: true as const } : {}) })
  }
  return out
}

const MAX_LEAD = 200

/** A scheme and userinfo cut from the left, so a long run of userinfo cannot push the host past the cut `tidy` makes. */
const clipStart = (text: string): string => text.length > MAX_LEAD ? `…${text.slice(text.length - MAX_LEAD + 1)}` : text

/** `full` keeps the scheme, `www.` and a bare trailing slash, so what shows is the literal address. Only http
 * and https lose their scheme: any other one names where the content comes from, so it stays. */
export function formatAddress (displayUrl: string, options: { readonly full: boolean }): AddressPart[] {
  const match = ADDRESS.exec(displayUrl)
  if (match === null) return tidy([{ text: displayUrl, tone: 'strong' }])
  const [, scheme = '', authority = '', tail = ''] = match
  const { host, port } = splitAuthority(authority)
  if (host === '') return tidy([{ text: `${scheme}://`, tone: 'dim' }, { text: `${port}${tail}`, tone: 'strong' }])
  const trimmed = /^https?$/i.test(scheme) && !options.full
  const userinfo = authority.slice(0, authority.length - host.length - port.length)
  const name = trimmed ? host.replace(/^www\.(?=.)/i, '') : host
  const rest = trimmed && /^\/?$/.test(tail) ? '' : tail
  const lead: AddressPart[] = trimmed ? [] : [{ text: clipStart(`${scheme}://${userinfo}`), tone: 'dim' }]
  return tidy([...lead, ...hostParts(name), { text: port, tone: 'dim' }, { text: rest, tone: 'dim' }])
}
