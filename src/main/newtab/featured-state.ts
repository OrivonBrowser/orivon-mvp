// What a profile chose about the "Orivon Featured" row: the app a new profile was given first, the entries it
// unpinned and the ones it hid. Pure functions over a plain value; `featured-store.ts` keeps it on disk. A tile is named
// by its key: an app's id (the name label of its `.orivonstack.eth` address), or the full address of any other app.

export interface FeaturedState {
  /** The app shown first because the profile was given it; null once the person removed it, or when none was given. */
  readonly newcomerPin: string | null
  /** What to call the pinned app when it is not among the shipped entries; null shows the key. */
  readonly newcomerName: string | null
  /** A pin was given once. It is never given again, not even after the person removed it. */
  readonly given: boolean
  readonly unpinned: readonly string[]
  readonly hidden: readonly string[]
}

export const EMPTY_STATE: FeaturedState = { newcomerPin: null, newcomerName: null, given: false, unpinned: [], hidden: [] }

const FILE_VERSION = 1
const MAX_KEY_LENGTH = 2048
const MAX_KEYS = 500
const SLUG = /^[a-z0-9-]{1,63}$/
const ORIVON_NAME = /^ipfs:\/\/([a-z0-9-]{1,63})\.orivonstack\.eth\/?$/

/** The key for an app id or address; null for text that is neither (an address that is not `ipfs://` or `https://`, say), which no tile could open safely. */
export function appKey (appIdOrUrl: string): string | null {
  const text = appIdOrUrl.trim().toLowerCase()
  if (SLUG.test(text)) return text
  const label = ORIVON_NAME.exec(text)?.[1]
  if (label !== undefined) return label
  if (text.length > MAX_KEY_LENGTH) return null
  try {
    const url = new URL(text)
    return url.protocol === 'ipfs:' || url.protocol === 'https:' ? url.href : null
  } catch {
    return null
  }
}

function added (list: readonly string[], key: string): readonly string[] {
  return list.includes(key) ? list : [...list, key].slice(-MAX_KEYS)
}

const MAX_NAME_LENGTH = 40

/** A name to show for an app: printable text of a modest length, else null. */
function displayName (name: unknown): string | null {
  if (typeof name !== 'string') return null
  const text = name.replace(/\p{C}/gu, '').trim()
  return text === '' || text.length > MAX_NAME_LENGTH ? null : text
}

/** Gives the profile its newcomer pin. Does nothing once one was given (shown, or removed by the person), or for text that is no app. */
export function giveNewcomerPin (state: FeaturedState, appIdOrUrl: string, name?: string): FeaturedState {
  const key = appKey(appIdOrUrl)
  if (key === null || state.given) return state
  return { ...state, newcomerPin: key, newcomerName: displayName(name), given: true }
}

/** The pin and its name after `key` is removed from the row: gone when it was the pin, as they were otherwise. */
function withoutPin (state: FeaturedState, key: string): Pick<FeaturedState, 'newcomerPin' | 'newcomerName'> {
  return state.newcomerPin === key ? { newcomerPin: null, newcomerName: null } : { newcomerPin: state.newcomerPin, newcomerName: state.newcomerName }
}

/** Hides a tile. A hidden newcomer pin is removed for good. */
export function hideTile (state: FeaturedState, id: string): FeaturedState {
  const key = appKey(id)
  return key === null ? state : { ...state, ...withoutPin(state, key), hidden: added(state.hidden, key) }
}

/** Unpins a tile: it stays in the row at its place among the rest. An unpinned newcomer pin is removed for good. */
export function unpinTile (state: FeaturedState, id: string): FeaturedState {
  const key = appKey(id)
  return key === null ? state : { ...state, ...withoutPin(state, key), unpinned: added(state.unpinned, key) }
}

/** Brings every hidden tile back. A removed newcomer pin stays removed. */
export function showHidden (state: FeaturedState): FeaturedState {
  return state.hidden.length === 0 ? state : { ...state, hidden: [] }
}

function keysOf (value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const keys = (value as unknown[]).flatMap((item) => typeof item === 'string' && appKey(item) === item ? [item] : [])
  return keys.slice(-MAX_KEYS)
}

/** The state out of a parsed file; anything that is not what this version wrote is dropped, since a person can edit the file. */
export function parseState (parsed: unknown): FeaturedState {
  const record = typeof parsed === 'object' && parsed !== null ? parsed as Record<string, unknown> : {}
  if (record['version'] !== FILE_VERSION) return EMPTY_STATE
  const pin = typeof record['newcomerPin'] === 'string' && appKey(record['newcomerPin']) === record['newcomerPin'] ? record['newcomerPin'] : null
  return { newcomerPin: pin, newcomerName: pin === null ? null : displayName(record['newcomerName']), given: record['given'] === true || pin !== null, unpinned: keysOf(record['unpinned']), hidden: keysOf(record['hidden']) }
}

export function serializeState (state: FeaturedState): string {
  return JSON.stringify({ version: FILE_VERSION, ...state }, null, 2)
}
