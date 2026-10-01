// The words next to the find bar's input.

/** "3 of 17", "No results", or nothing while there is no query or no answer yet. Numbers follow the person's locale. */
export function countText (query: string, counted: { active: number, total: number } | null, locale?: string): string {
  if (query === '' || counted === null) return ''
  if (counted.total === 0) return 'No results'
  return `${counted.active.toLocaleString(locale)} of ${counted.total.toLocaleString(locale)}`
}
