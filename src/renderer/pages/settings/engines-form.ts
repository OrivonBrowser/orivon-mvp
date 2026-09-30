// The form for a search engine, apart from its drawing: what a draft is, the words for every way main can
// refuse one, and which field to blame. Main judges a draft; this only says what it found in a person's terms.
import type { EngineView } from '../../../main/browsing/search-resolve.js'

export interface Draft {
  name: string
  keyword: string
  template: string
}

export type Field = keyof Draft

/** What main answers to an add or an edit that it refused. */
export interface Refusal {
  readonly field?: string
  readonly reason: string
  readonly usedBy?: string
}

export const emptyDraft = (): Draft => ({ name: '', keyword: '', template: '' })
export const draftOf = (engine: EngineView): Draft => ({ name: engine.name, keyword: engine.keyword, template: engine.template })

const FIELDS: readonly Field[] = ['name', 'keyword', 'template']
export const isField = (value: unknown): value is Field => typeof value === 'string' && (FIELDS as readonly string[]).includes(value)

const MESSAGES: Record<Field, Record<string, string>> = {
  name: {
    required: 'Give the search engine a name.',
    'too-long': 'Use 60 characters or fewer.',
    format: 'Use a name without line breaks or other control characters.'
  },
  keyword: {
    required: 'Give it a keyword, for example w.',
    'too-long': 'Use 20 characters or fewer.',
    format: 'Use letters, digits, dots, hyphens or underscores, with no spaces.'
  },
  template: {
    required: 'Add the search address.',
    template: 'Use an address that starts with https://, has %s where the search goes, and has no user name or password.'
  }
}

const GENERAL: Record<string, string> = {
  private: 'Search engines cannot be changed in a private window.',
  limit: 'There are as many search engines as can be kept. Remove one first.',
  'not-found': 'That search engine is no longer in the list.',
  builtin: 'The built-in search engines cannot be changed.'
}

/** The field to put the message under, and the message. A refusal with no field is shown under the form. */
export function problemFor (refusal: Refusal): { field: Field | null, text: string } {
  const field = isField(refusal.field) ? refusal.field : null
  if (field === 'keyword' && refusal.reason === 'used') {
    return { field, text: `This keyword is already used by ${refusal.usedBy ?? 'another search engine'}.` }
  }
  const text = (field === null ? undefined : MESSAGES[field][refusal.reason]) ?? GENERAL[refusal.reason] ?? 'That search engine cannot be saved.'
  return { field, text }
}

/** The mark's colour: one of the shared palette's names, the same for the same name every time. */
const MARK_COLORS = ['blue', 'green', 'orange', 'red', 'purple', 'pink', 'teal'] as const
export function markColor (name: string): string {
  let sum = 0
  for (const character of name) sum = (sum + (character.codePointAt(0) ?? 0)) % 997
  return MARK_COLORS[sum % MARK_COLORS.length] as string
}

export const markLetter = (name: string): string => (Array.from(name.trim())[0] ?? '?').toUpperCase()
