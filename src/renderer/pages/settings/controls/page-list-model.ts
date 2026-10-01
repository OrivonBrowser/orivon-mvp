// The decisions of the "pages to open" list, apart from its DOM: what adding, removing and showing an address do.
// The list is the newline-separated text of `startup.pages`.

/** The most pages the setting holds; main's check says the same. */
export const MAX_PAGES = 8

export const PROBLEM_ADDRESS = 'Enter a web address, like https://example.com'
export const PROBLEM_FULL = `You can open up to ${String(MAX_PAGES)} pages at start-up`
export const PLACEHOLDER_FULL = `You can open up to ${String(MAX_PAGES)} pages`
export const PLACEHOLDER_ADD = 'Add a page, like example.com'
export const PROBLEM_UNAVAILABLE = 'Orivon could not do that. Try again.'
export const NOTE_NONE_OPEN = 'No other pages are open right now.'
export const PROBLEM_SAVE = 'The pages could not be saved. Try again.'

export function splitPages (value: unknown): string[] {
  if (typeof value !== 'string') return []
  return value.split('\n').map((line) => line.trim()).filter((line) => line !== '')
}

export const joinPages = (pages: readonly string[]): string => pages.join('\n')

export type AddOutcome =
  | { readonly kind: 'added', readonly pages: string[] }
  /** Already listed: nothing changes and nothing is said. */
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'full' }

/** `address` is the normalised form main gave back, so two spellings of one page are one entry. */
export function addPage (pages: readonly string[], address: string): AddOutcome {
  if (pages.includes(address)) return { kind: 'duplicate' }
  if (pages.length >= MAX_PAGES) return { kind: 'full' }
  return { kind: 'added', pages: [...pages, address] }
}

export function removePage (pages: readonly string[], index: number): string[] {
  return pages.filter((_, position) => position !== index)
}

/** Where focus goes once the row at `index` is gone: the button now in its place, else the last one, else the field. */
export function focusAfterRemove (remaining: number, index: number): { readonly kind: 'remove', readonly index: number } | { readonly kind: 'field' } {
  if (remaining === 0) return { kind: 'field' }
  return { kind: 'remove', index: Math.min(index, remaining - 1) }
}

/** The address cut in the middle when it is long, where the end of a path is as telling as the start. */
export function shorten (address: string, max = 56): string {
  if (address.length <= max) return address
  const tail = Math.floor((max - 1) * 0.4)
  return `${address.slice(0, max - 1 - tail)}…${address.slice(address.length - tail)}`
}
