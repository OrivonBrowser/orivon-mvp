// Strips the person's home directory out of text before it is shown or sent: the one piece of a path that
// names them. Everything else in a stack or a log line is Orivon's own.

/** The directory spelled both ways a message may carry it: a Windows path is written with either slash. */
function variants (home: string): string[] {
  return [...new Set([home, home.replaceAll('\\', '/')])].filter((variant) => variant.length > 1 && variant !== '/')
}

function escapeForRegExp (text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** `home` becomes `~`, wherever it starts a path. A longer directory name that merely begins with it (`/home/ann` and `/home/anna`) is left alone. */
export function redactHome (text: string, home: string, ignoreCase = false): string {
  const found = variants(home).map(escapeForRegExp)
  if (found.length === 0) return text
  const pattern = new RegExp(`(?:${found.join('|')})(?![A-Za-z0-9_.-])`, ignoreCase ? 'gi' : 'g')
  return text.replace(pattern, '~')
}

/** A value with `redactHome` applied to every string inside it, arrays and objects included. */
export function redactDeep<T> (value: T, home: string, ignoreCase = false): T {
  if (typeof value === 'string') return redactHome(value, home, ignoreCase) as T
  if (Array.isArray(value)) return value.map((entry) => redactDeep(entry as unknown, home, ignoreCase)) as T
  if (typeof value === 'object' && value !== null) {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, redactDeep(entry as unknown, home, ignoreCase)])) as T
  }
  return value
}
