// Durable: no Electron import. What the shell hands Chromium as the referrer of a navigation it stopped and
// re-issues in another session (`./pre-partition.ts`).
//
// The rule: never more than Chromium would have sent for that navigation. What is worked out here is which policy governs the
// navigation (the document's, the link's, `rel="noreferrer"`); Chromium then applies it to the initiating document's address and
// the target, as it does for any navigation: it strips the fragment and credentials, keeps the origin where the policy says so
// and sends nothing on a downgrade a policy forbids. When the policy cannot be told, nothing is sent.

/** The policies a navigation's referrer follows. `default` is the browser's own (strict-origin-when-cross-origin). */
export const REFERRER_POLICIES = ['default', 'no-referrer', 'no-referrer-when-downgrade', 'origin', 'origin-when-cross-origin', 'same-origin', 'strict-origin', 'strict-origin-when-cross-origin', 'unsafe-url'] as const
export type ReferrerPolicy = typeof REFERRER_POLICIES[number]

/** What the page that started the navigation says started it: no element (a script), or one element with the two attributes that change the referrer. */
export type NavigationSource =
  | { readonly kind: 'script' }
  | { readonly kind: 'element', readonly tag: string, readonly rel: string | null, readonly referrerPolicy: string | null }

/** What the initiating document reports when main asks (`../../preload/navigation-source.ts` keeps the notes). */
export interface NavigationReport {
  /** The initiating document's address now. */
  readonly href: string
  /** The address the document was loaded at, which its response is recorded under. */
  readonly documentUrl: string
  /** Every `content` a `<meta name="referrer">` of the document has held. */
  readonly metaPolicies: readonly string[]
  /** The address of the last navigation the document started. */
  readonly destination: string
  /** What started that navigation, or undefined when the page cannot say (the platform names no source). */
  readonly source: NavigationSource | undefined
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
const stringOrNull = (value: unknown): string | null | undefined => value === null || typeof value === 'string' ? value : undefined

/** The report a page's answer is, or undefined for anything else: the renderer is not trusted to send the shape. */
export function parseReport (value: unknown): NavigationReport | undefined {
  if (!isRecord(value)) return undefined
  const { href, documentUrl, destination, metaPolicies, source } = value
  if (typeof href !== 'string' || typeof documentUrl !== 'string' || typeof destination !== 'string') return undefined
  if (!Array.isArray(metaPolicies) || !metaPolicies.every((one): one is string => typeof one === 'string')) return undefined
  const common = { href, documentUrl, destination, metaPolicies: [...metaPolicies] as string[] }
  if (source === undefined || source === null) return { ...common, source: undefined }
  if (!isRecord(source)) return undefined
  if (source['kind'] === 'script') return { ...common, source: { kind: 'script' } }
  const rel = stringOrNull(source['rel'])
  const referrerPolicy = stringOrNull(source['referrerPolicy'])
  if (source['kind'] !== 'element' || typeof source['tag'] !== 'string' || rel === undefined || referrerPolicy === undefined) return undefined
  return { ...common, source: { kind: 'element', tag: source['tag'], rel, referrerPolicy } }
}

const NAMED_POLICIES: ReadonlySet<string> = new Set(REFERRER_POLICIES.filter((name) => name !== 'default'))
/** What a `<meta name="referrer">` still reads as, besides the names above. */
const LEGACY_META: Readonly<Record<string, ReferrerPolicy>> = { never: 'no-referrer', always: 'unsafe-url', 'origin-when-crossorigin': 'origin-when-cross-origin', default: 'default' }

/** The policy one name sets: 'unset' when empty, undefined for a value Chromium might read differently. */
function namedPolicy (value: string): ReferrerPolicy | 'unset' | undefined {
  const name = value.toLowerCase()
  if (name === '') return 'unset'
  return NAMED_POLICIES.has(name) ? name as ReferrerPolicy : undefined
}

/** A value read as written. Chromium may or may not trim a `referrerpolicy` attribute or a tag's content, so a value with white space around it is not one this module reads. */
const asWritten = (value: string): string | undefined => value === value.trim() ? value : undefined

/** The policy a `Referrer-Policy` header sets: its last name, 'unset' when it has none, undefined when any entry is not a name every Chromium reads alike. */
function headerPolicy (value: string): ReferrerPolicy | 'unset' | undefined {
  let last: ReferrerPolicy | 'unset' = 'unset'
  for (const entry of value.split(',')) {
    const policy = namedPolicy(entry.trim())
    if (policy === undefined) return undefined
    if (policy !== 'unset') last = policy
  }
  return last
}

/**
 * The policy a document holds, from its `Referrer-Policy` header (`header`: the header's value, empty when the response had none,
 * undefined when the response was not seen) and the `<meta name="referrer">` values it has held. Undefined when that cannot be
 * told: an unseen response, a value Chromium might read differently, or two sources that disagree (the later one wins, and which
 * was later is not known here).
 */
export function documentPolicyOf (header: string | undefined, metaPolicies: readonly string[]): ReferrerPolicy | undefined {
  if (header === undefined) return undefined
  const fromHeader = headerPolicy(header)
  if (fromHeader === undefined) return undefined
  const held = new Set<ReferrerPolicy>()
  if (fromHeader !== 'unset') held.add(fromHeader)
  for (const content of metaPolicies) {
    if (content === '') continue
    const name = asWritten(content)?.toLowerCase()
    if (name === undefined) return undefined
    const policy = LEGACY_META[name] ?? (NAMED_POLICIES.has(name) ? name as ReferrerPolicy : undefined)
    if (policy === undefined) return undefined
    held.add(policy)
  }
  if (held.size > 1) return undefined
  return [...held][0] ?? 'default'
}

const hasNoReferrer = (rel: string | null): boolean => (rel ?? '').toLowerCase().split(/\s+/).includes('noreferrer')

/** An address other than http(s) is never sent as a referrer. */
function webAddress (value: string): URL | undefined {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' || url.protocol === 'https:' ? url : undefined
  } catch {
    return undefined
  }
}

/** Compares addresses without their fragment: the one a link carries and the one the navigation reports differ only there when a page edits the hash. */
function sameAddress (a: string, b: string): boolean {
  try {
    const first = new URL(a)
    const second = new URL(b)
    first.hash = ''
    second.hash = ''
    return first.href === second.href
  } catch {
    return false
  }
}

/**
 * The policy governing a navigation: `rel="noreferrer"` on a link or form beats the link's `referrerpolicy`, which beats the
 * document's. Undefined when that cannot be told: an element that is none of `a`, `area` and `form`, or a policy name Chromium
 * might read differently.
 */
function policyFor (documentPolicy: ReferrerPolicy, source: NavigationSource): ReferrerPolicy | undefined {
  if (source.kind === 'script') return documentPolicy
  if (source.tag !== 'a' && source.tag !== 'area' && source.tag !== 'form') return undefined
  // Chromium reads no `rel` on a form, but a future one may; honouring it can only send less.
  if (hasNoReferrer(source.rel)) return 'no-referrer'
  // A form has no referrer policy of its own to read.
  if (source.tag === 'form' || source.referrerPolicy === null) return documentPolicy
  const written = asWritten(source.referrerPolicy)
  const element = written === undefined ? undefined : namedPolicy(written)
  if (element === undefined) return undefined
  return element === 'unset' ? documentPolicy : element
}

/** What `loadURL` takes as its referrer: the initiating document's address and the policy Chromium applies to it. Electron types every policy but `origin-when-cross-origin`. */
export interface NavigationReferrer {
  readonly url: string
  readonly policy: Exclude<ReferrerPolicy, 'origin-when-cross-origin'>
}

/** `origin-when-cross-origin` is the origin across origins and the whole address within one, which two policies Electron types say. */
function loadablePolicy (policy: ReferrerPolicy, source: URL, target: string): NavigationReferrer['policy'] {
  if (policy !== 'origin-when-cross-origin') return policy
  return sameOrigin(source, target) ? 'default' : 'origin'
}

function sameOrigin (source: URL, target: string): boolean {
  try {
    return source.origin === new URL(target).origin
  } catch {
    return false
  }
}

/**
 * The referrer to load `target` with, or undefined to send none. `initiator` is the address of the frame that started the
 * navigation, as main read it when the navigation was announced; `header` is the `Referrer-Policy` of the document's response
 * (`documentPolicyOf`).
 */
export function referrerFor (initiator: string, target: string, report: NavigationReport | undefined, header: string | undefined): NavigationReferrer | undefined {
  if (report === undefined || report.source === undefined) return undefined
  // The page moved on, or the last navigation it reports is not this one.
  if (report.href !== initiator || !sameAddress(report.destination, target)) return undefined
  const source = webAddress(report.href)
  // Chromium sends none to an address that is not http(s).
  if (webAddress(target) === undefined) return undefined
  const documentPolicy = documentPolicyOf(header, report.metaPolicies)
  if (source === undefined || documentPolicy === undefined) return undefined
  const policy = policyFor(documentPolicy, report.source)
  if (policy === undefined || policy === 'no-referrer') return undefined
  source.hash = ''
  source.username = ''
  source.password = ''
  return { url: source.href, policy: loadablePolicy(policy, source, target) }
}
