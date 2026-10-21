// What a version changed for the people using it, read from CHANGELOG.md's `## [x.y.z]` section. Pure: the
// build (electron.vite.config.ts) calls it once and folds the result into the main bundle, so the browser
// never reads the file and a page of notes costs no request.

/** The CHANGELOG subsections that list shipped changes. "Changed for apps" is for app authors and is left out. */
const SHIPPED_HEADINGS = ['added', 'changed', 'fixed', 'security', 'removed', 'deprecated']

export interface ReleaseNotesSection {
  /** The subsection's own heading: Added, Changed, Fixed... */
  readonly heading: string
  /** One CHANGELOG bullet each, as markdown text without its dash. */
  readonly items: readonly string[]
}

export interface ReleaseNotes {
  readonly version: string
  readonly sections: readonly ReleaseNotesSection[]
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The lines under `## [version]` up to the next `## ` heading, or null when CHANGELOG.md has no such section. */
export function changelogSection (changelog: string, version: string): string[] | null {
  const lines = changelog.replace(/\r\n?/g, '\n').split('\n')
  const heading = new RegExp(`^##\\s+\\[${escapeRegex(version)}\\](\\s|$)`)
  const start = lines.findIndex((line) => heading.test(line))
  if (start === -1) return null
  const rest = lines.slice(start + 1)
  const end = rest.findIndex((line) => /^##\s/.test(line))
  return end === -1 ? rest : rest.slice(0, end)
}

/** The shipped subsections of a version, or null when CHANGELOG.md holds no section for it or nothing shipped in it. */
export function releaseNotes (changelog: string, version: string): ReleaseNotes | null {
  const section = changelogSection(changelog, version)
  if (section === null) return null
  const sections: { heading: string, items: string[] }[] = []
  let current: { heading: string, items: string[] } | null = null
  for (const line of section) {
    const heading = /^###\s+(.*?)\s*$/.exec(line)
    if (heading !== null) {
      const name = heading[1] ?? ''
      current = SHIPPED_HEADINGS.includes(name.toLowerCase()) ? { heading: name, items: [] } : null
      if (current !== null) sections.push(current)
      continue
    }
    if (current === null) continue
    const bullet = /^[-*]\s+(.*)$/.exec(line)
    if (bullet !== null) current.items.push((bullet[1] ?? '').trim())
    else if (/^\s+\S/.test(line) && current.items.length > 0) current.items[current.items.length - 1] += ` ${line.trim()}`
  }
  const filled = sections.filter((entry) => entry.items.length > 0)
  return filled.length === 0 ? null : { version, sections: filled }
}
