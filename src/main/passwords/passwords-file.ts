// What `passwords.json` holds and how it is checked on the way in. Pure: the file is read and written by
// ./encrypted-vault.ts, and every limit a login must meet lives here so the file, the store and the CSV importer agree.
import { originFromUrl } from '../../broker/policy/origin.js'

export const FILE_VERSION = 1
export const MAX_LOGINS = 2000
export const MAX_NEVER = 2000
export const MAX_USERNAME = 256
export const MAX_PASSWORD = 1024
/** A ciphertext is a few dozen bytes more than its password; this bounds a forged entry, not a real one. */
const MAX_SECRET_CHARS = 8192
const MAX_ID = 64
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/

/** A login as it sits on disk: the password is only ever the keyring's ciphertext. */
export interface StoredLogin {
  id: string
  origin: string
  username: string
  secret: string
  created: number
  used: number
}

/** An origin a login may belong to: `http(s)://host[:port]` in the canonical shape. */
export function isStorableOrigin (origin: unknown): origin is string {
  return typeof origin === 'string' && /^https?:\/\//.test(origin) && originFromUrl(origin) === origin
}

export const loginKey = (origin: string, username: string): string => `${origin}\n${username}`

function isStoredLogin (value: unknown): value is StoredLogin {
  if (typeof value !== 'object' || value === null) return false
  const entry = value as Record<string, unknown>
  return typeof entry['id'] === 'string' && entry['id'] !== '' && entry['id'].length <= MAX_ID &&
    isStorableOrigin(entry['origin']) &&
    typeof entry['username'] === 'string' && entry['username'].length <= MAX_USERNAME &&
    typeof entry['secret'] === 'string' && entry['secret'] !== '' && entry['secret'].length <= MAX_SECRET_CHARS && BASE64.test(entry['secret']) &&
    typeof entry['created'] === 'number' && Number.isFinite(entry['created']) && entry['created'] >= 0 &&
    typeof entry['used'] === 'number' && Number.isFinite(entry['used']) && entry['used'] >= 0
}

export type ParsedFile =
  /** Something is there that this build cannot make sense of as a whole. It must be left exactly as it is. */
  | { readonly status: 'corrupt', readonly reason: string }
  | { readonly status: 'ok', readonly logins: StoredLogin[], readonly never: string[], readonly dropped: number }

/** Reads the file's text. Entries that fail the checks, repeat an id or a login, or exceed the cap are dropped and counted; a file that is not the expected shape at all is `corrupt`. */
export function parsePasswordsFile (text: string): ParsedFile {
  let data: unknown
  try {
    data = JSON.parse(text)
  } catch {
    return { status: 'corrupt', reason: 'it is not valid JSON' }
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) return { status: 'corrupt', reason: 'it is not an object' }
  const file = data as { version?: unknown, logins?: unknown, never?: unknown }
  if (file.version !== FILE_VERSION) return { status: 'corrupt', reason: 'it is written by another version' }
  if (!Array.isArray(file.logins)) return { status: 'corrupt', reason: 'it has no list of logins' }

  const logins: StoredLogin[] = []
  const ids = new Set<string>()
  const keys = new Set<string>()
  let dropped = 0
  for (const candidate of file.logins as unknown[]) {
    if (!isStoredLogin(candidate) || ids.has(candidate.id) || keys.has(loginKey(candidate.origin, candidate.username)) || logins.length >= MAX_LOGINS) {
      dropped += 1
      continue
    }
    ids.add(candidate.id)
    keys.add(loginKey(candidate.origin, candidate.username))
    logins.push({ id: candidate.id, origin: candidate.origin, username: candidate.username, secret: candidate.secret, created: candidate.created, used: candidate.used })
  }
  const never: string[] = []
  if (Array.isArray(file.never)) {
    for (const origin of file.never as unknown[]) {
      if (isStorableOrigin(origin) && !never.includes(origin) && never.length < MAX_NEVER) never.push(origin)
      else dropped += 1
    }
  }
  return { status: 'ok', logins, never, dropped }
}

export function printPasswordsFile (logins: Iterable<StoredLogin>, never: Iterable<string>): string {
  return JSON.stringify({ version: FILE_VERSION, logins: [...logins], never: [...never] }, null, 2)
}
