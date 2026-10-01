import { formatKeys } from '../menu/keys.js'

/** The sentence that says how to turn caret browsing off again: the key as bound now, or Settings when it has none. */
export function turnOffText (keys: unknown, platform: string): string {
  const bound = Array.isArray(keys) && keys.length > 0 && keys.every((key) => typeof key === 'string') ? keys as string[] : null
  return bound === null ? 'You can turn it off again in Settings.' : `Press ${formatKeys(bound, platform)} to turn it off again.`
}
