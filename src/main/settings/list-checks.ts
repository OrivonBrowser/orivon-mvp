// What a setting that holds a list as one line of text must look like: sites (one per line), font names and
// language tags. The Settings controls that edit them write the canonical form, which is what these accept.

export const MAX_LISTED_HOSTS = 200
export const MAX_LANGUAGE_TAGS = 12

const HOST = /^[a-z0-9.-]{1,253}$/
const FONT = /^[\p{L}\p{N} ._-]{0,64}$/u
const LANGUAGE_TAG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/

/** Empty, or at most `MAX_LISTED_HOSTS` lowercase host names, one per line, none blank. */
export function isHostList (value: string): boolean {
  if (value === '') return true
  const lines = value.split('\n')
  return lines.length <= MAX_LISTED_HOSTS && lines.every((line) => HOST.test(line))
}

/** Empty, or a font family name: letters, digits, spaces and `. _ -`. */
export function isFontName (value: string): boolean {
  return FONT.test(value)
}

/** Empty, or at most `MAX_LANGUAGE_TAGS` language tags such as `en-US`, separated by commas with no spaces. */
export function isLanguageTagList (value: string): boolean {
  if (value === '') return true
  const tags = value.split(',')
  return tags.length <= MAX_LANGUAGE_TAGS && tags.every((tag) => LANGUAGE_TAG.test(tag))
}
