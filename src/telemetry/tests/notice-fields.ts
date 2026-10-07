// Reading the fields a payload sends and the fields a notice lists, for the drift tests that compare them.

/** Dotted paths of every key, going into objects but treating each key in `leaves` (a map of site names, a block the notice describes in prose) as one field. */
export function fieldPaths (value: unknown, leaves: readonly string[] = ['sites'], prefix = ''): string[] {
  if (typeof value !== 'object' || value === null) return []
  return Object.entries(value).flatMap(([key, inner]) => {
    const path = prefix === '' ? key : `${prefix}.${key}`
    return leaves.includes(key) || typeof inner !== 'object' || inner === null ? [path] : fieldPaths(inner, leaves, path)
  })
}

/** The first column of the table under the `## <heading>` section of a notice. */
export function noticeFields (text: string, heading: string): string[] {
  const section = text.split(/^## /m).find((part) => part.startsWith(heading))
  if (section === undefined) return []
  return section.split('\n')
    .filter((line) => line.startsWith('|'))
    .map((line) => /^\|\s*`([A-Za-z0-9_.]+)`\s*\|/.exec(line)?.[1])
    .filter((field): field is string => field !== undefined)
}
