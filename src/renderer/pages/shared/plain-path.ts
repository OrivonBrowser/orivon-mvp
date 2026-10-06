/** Bidirectional controls and every control character: they reorder or hide what is drawn, so a file name could pass for another path or extension. */
const UNSAFE = /[\p{Cc}؜‎‏‪-‮⁦-⁩]/gu

/** A path as it is drawn: bidirectional and control characters left out. */
export function plainPath (path: string): string {
  return path.replace(UNSAFE, '')
}
