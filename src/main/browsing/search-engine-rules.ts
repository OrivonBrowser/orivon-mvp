// What makes a person's search engine acceptable. Pure: the store and the Settings domain both ask it, so a
// draft is judged one way whichever door it came through.
import { isValidSearchTemplate } from './search-engines.js'
import type { EngineView } from './search-resolve.js'

export const MAX_NAME_LENGTH = 60
export const MAX_KEYWORD_LENGTH = 20
export const MAX_ENGINES = 200

export interface EngineDraft {
  readonly name: string
  readonly keyword: string
  readonly template: string
}

export type EngineField = 'name' | 'keyword' | 'template'
export type EngineReason = 'required' | 'too-long' | 'format' | 'used' | 'template'

export type DraftCheck =
  | { readonly ok: true, readonly value: EngineDraft }
  | { readonly ok: false, readonly field: EngineField, readonly reason: EngineReason, readonly usedBy?: string }

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/

/** A keyword has no space and no `:`, so it can never read as a scheme or as part of an address. */
export const isKeywordText = (text: string): boolean => /^[A-Za-z0-9._-]+$/.test(text)

/** `others` are the engines the draft must not collide with: every engine but the one being edited. */
export function checkDraft (draft: EngineDraft, others: readonly EngineView[]): DraftCheck {
  const name = draft.name.trim()
  if (name === '') return { ok: false, field: 'name', reason: 'required' }
  if (name.length > MAX_NAME_LENGTH) return { ok: false, field: 'name', reason: 'too-long' }
  if (CONTROL.test(name)) return { ok: false, field: 'name', reason: 'format' }

  const keyword = draft.keyword.trim()
  if (keyword === '') return { ok: false, field: 'keyword', reason: 'required' }
  if (keyword.length > MAX_KEYWORD_LENGTH) return { ok: false, field: 'keyword', reason: 'too-long' }
  if (!isKeywordText(keyword)) return { ok: false, field: 'keyword', reason: 'format' }
  const owner = others.find((engine) => engine.keyword.toLowerCase() === keyword.toLowerCase())
  if (owner !== undefined) return { ok: false, field: 'keyword', reason: 'used', usedBy: owner.name }

  const template = draft.template.trim()
  if (template === '') return { ok: false, field: 'template', reason: 'required' }
  if (!isValidSearchTemplate(template)) return { ok: false, field: 'template', reason: 'template' }
  return { ok: true, value: { name, keyword, template } }
}
