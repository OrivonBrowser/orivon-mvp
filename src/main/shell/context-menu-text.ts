// The strings a page controls that reach a native menu: a selection, a
// misspelt word, a suggestion. A menu label is parsed for mnemonics and has no
// room for a paragraph, so they are cleaned and cut here. Pure: no Electron.
import { CUSTOM_SEARCH_ENGINE, SEARCH_ENGINES } from '../browsing/search-engines.js'

const LABEL_LIMIT = 30
/** What a search may carry: a whole paragraph is a selection, not a question. */
const QUERY_LIMIT = 1000
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g

const collapse = (text: string): string => text.replace(CONTROL, ' ').replace(/\s+/g, ' ').trim()

/** A page-controlled string as one line of a menu label: `&` doubled so no mnemonic appears, control characters gone. */
export function menuSafe (text: string): string {
  return collapse(text).replace(/&/g, '&&')
}

/** The text a search is made for: whitespace collapsed, at most 1,000 characters. Empty when the selection is blank. */
export function queryFrom (selection: string): string {
  return collapse(selection).slice(0, QUERY_LIMIT)
}

/** The name of the engine a search goes to. A custom template has no name a menu can trust. */
export function engineLabelFor (engineId: string): string {
  if (engineId === CUSTOM_SEARCH_ENGINE) return 'the Web'
  return SEARCH_ENGINES.find((engine) => engine.id === engineId)?.label ?? 'the Web'
}

/** `Search <Engine> for “<text>”`, the text cut to 30 characters. */
export function searchLabel (engineLabel: string, selection: string): string {
  const query = queryFrom(selection)
  const shown = query.length > LABEL_LIMIT ? `${query.slice(0, LABEL_LIMIT).trimEnd()}…` : query
  return `Search ${menuSafe(engineLabel)} for “${menuSafe(shown)}”`
}
