// Which section a path names. A deep link is `orivon://settings/<section>`, so
// the address bar always says where the person is.
import type { Section } from './model.js'

export interface Place {
  readonly section: Section
  /** The path this place should have, when the one asked for is not it. */
  readonly canonicalPath: string | null
}

export function pathFor (section: Section): string {
  return `/${section.id}`
}

/** An unknown or empty path falls back to the first section, and says what its path should be. */
export function placeFor (pathname: string, sections: readonly Section[]): Place {
  const first = sections[0]
  if (first === undefined) throw new Error('the Settings page has no sections')
  const id = pathname.split('/').filter((part) => part !== '')[0]
  const found = sections.find((section) => section.id === id)
  if (found !== undefined) return { section: found, canonicalPath: pathname === pathFor(found) ? null : pathFor(found) }
  return { section: first, canonicalPath: pathFor(first) }
}
