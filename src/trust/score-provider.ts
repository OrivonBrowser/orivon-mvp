// What a Web3 Score provider answers, read as docs/architecture/web3-score-provider.md defines
// it. Pure: fetching is ../main/browsing/score-provider-client.ts's job.

export const SCORE_STANDARD = 'orivon-web3-score/1'
export const MAX_SCORE_FILE_BYTES = 1024 * 1024

export type ScoreSubject = 'website' | 'operation' | 'connection'

export interface Trustlessity {
  readonly level: number
  readonly privacy: boolean
}

export interface ScorePart {
  readonly name: string
  readonly trustlessity: Trustlessity
  readonly note: string | undefined
}

export interface Evaluation {
  readonly id: string
  readonly name: string
  readonly version: string | undefined
  readonly evaluated: string
  readonly trustlessity: Trustlessity
  readonly summary: string | undefined
  readonly operations: readonly ScorePart[]
  readonly connections: readonly ScorePart[]
  readonly evidence: readonly string[]
}

export interface ProviderDescriptor {
  readonly name: string
  readonly bucketHexChars: number
  readonly about: string | undefined
}

/** Who judged: the name the provider gives itself, and the address the person typed for it. */
export interface ProviderName {
  readonly name: string
  readonly address: string
}

export type ProviderVerdict =
  | { readonly status: 'off' }
  /** A provider is set, but this page's files were not checked (DDOC), so there is nothing to ask about. */
  | { readonly status: 'not-assessable', readonly address: string }
  | { readonly status: 'pending', readonly address: string }
  | { readonly status: 'unreachable', readonly address: string, readonly reason: string }
  | { readonly status: 'no-score', readonly provider: ProviderName }
  | { readonly status: 'judged', readonly provider: ProviderName, readonly evaluation: Evaluation }

export type BucketLookup =
  | { readonly kind: 'found', readonly evaluation: Evaluation }
  | { readonly kind: 'none' }
  | { readonly kind: 'malformed', readonly reason: string }

const SCALES: Readonly<Record<ScoreSubject, { readonly max: number, readonly privacyFrom: number }>> = {
  website: { max: 4, privacyFrom: 4 },
  operation: { max: 5, privacyFrom: 4 },
  connection: { max: 3, privacyFrom: 3 }
}

const MAX_PARTS = 32
const MAX_EVIDENCE = 10
const BUNDLE_HASH = /^sha256:[0-9a-f]{64}$/
const DATE = /^\d{4}-\d{2}-\d{2}$/

type Fields = Readonly<Record<string, unknown>>

function isFields (value: unknown): value is Fields {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function text (value: unknown, min: number, max: number): string | undefined {
  return typeof value === 'string' && value.length >= min && value.length <= max ? value : undefined
}

function optionalText (fields: Fields, key: string, max: number): string | undefined | null {
  if (!Object.hasOwn(fields, key)) return undefined
  return text(fields[key], 0, max) ?? null
}

/** The identifier a provider files a page's content under, or undefined for a value of the wrong shape. */
export function scoreIdOf (assessable: { readonly kind: 'cid' | 'bundle-hash', readonly value: string }): string | undefined {
  if (assessable.kind === 'bundle-hash') return BUNDLE_HASH.test(assessable.value) ? assessable.value : undefined
  return /^[a-z2-7]+$/.test(assessable.value) ? `cid:${assessable.value}` : undefined
}

export function parseDescriptor (value: unknown): ProviderDescriptor | undefined {
  if (!isFields(value) || value['standard'] !== SCORE_STANDARD) return undefined
  const name = text(value['name'], 1, 80)
  const bucketHexChars = value['bucketHexChars']
  const about = optionalText(value, 'about', 2048)
  if (name === undefined || about === null) return undefined
  if (typeof bucketHexChars !== 'number' || !Number.isInteger(bucketHexChars) || bucketHexChars < 1 || bucketHexChars > 4) return undefined
  return { name, bucketHexChars, about }
}

function parseTrustlessity (value: unknown, subject: ScoreSubject): Trustlessity | undefined {
  if (!isFields(value)) return undefined
  const { max, privacyFrom } = SCALES[subject]
  const level = value['level']
  const privacy = value['privacy'] ?? false
  if (typeof level !== 'number' || !Number.isInteger(level) || level < 1 || level > max) return undefined
  if (typeof privacy !== 'boolean' || (privacy && level < privacyFrom)) return undefined
  return { level, privacy }
}

function parseParts (value: unknown, subject: ScoreSubject): ScorePart[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_PARTS) return undefined
  const parts: ScorePart[] = []
  for (const item of value) {
    if (!isFields(item)) return undefined
    const name = text(item['name'], 1, 80)
    const trustlessity = parseTrustlessity(item['trustlessity'], subject)
    const note = optionalText(item, 'note', 300)
    if (name === undefined || trustlessity === undefined || note === null) return undefined
    parts.push({ name, trustlessity, note })
  }
  return parts
}

function parseEvidence (value: unknown): string[] | undefined {
  if (value === undefined) return []
  if (!Array.isArray(value) || value.length > MAX_EVIDENCE) return undefined
  const evidence = value.map((item) => text(item, 1, 2048))
  return evidence.every((item) => item !== undefined) ? evidence : undefined
}

/** One entry, or undefined when any field breaks the standard: the spec treats that as no evaluation at all. */
function parseEvaluation (entry: Fields, subject: ScoreSubject, id: string): Evaluation | undefined {
  const name = text(entry['name'], 1, 80)
  const evaluated = entry['evaluated']
  const trustlessity = parseTrustlessity(entry['trustlessity'], subject)
  const version = optionalText(entry, 'version', 40)
  const summary = optionalText(entry, 'summary', 600)
  const operations = subject === 'website' ? parseParts(entry['operations'], 'operation') : []
  const connections = subject === 'website' ? parseParts(entry['connections'], 'connection') : []
  const evidence = parseEvidence(entry['evidence'])
  if (name === undefined || trustlessity === undefined || version === null || summary === null) return undefined
  if (typeof evaluated !== 'string' || !DATE.test(evaluated) || Number.isNaN(Date.parse(evaluated))) return undefined
  if (operations === undefined || connections === undefined || evidence === undefined) return undefined
  return { id, name, version, evaluated, trustlessity, summary, operations, connections, evidence }
}

/** `id`'s evaluation in the bucket file a provider served for `subject`/`bucket`. */
export function findEvaluation (file: unknown, subject: ScoreSubject, bucket: string, id: string): BucketLookup {
  if (!isFields(file) || file['standard'] !== SCORE_STANDARD) return { kind: 'malformed', reason: `not an ${SCORE_STANDARD} file` }
  if (file['subject'] !== subject || file['bucket'] !== bucket) return { kind: 'malformed', reason: 'it answered for a different bucket' }
  const entries = file['entries']
  if (!Array.isArray(entries)) return { kind: 'malformed', reason: 'it lists no entries' }
  const entry: unknown = entries.find((item) => isFields(item) && item['id'] === id)
  if (!isFields(entry)) return { kind: 'none' }
  const evaluation = parseEvaluation(entry, subject, id)
  return evaluation === undefined ? { kind: 'none' } : { kind: 'found', evaluation }
}
