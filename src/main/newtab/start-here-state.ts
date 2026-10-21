// What a profile has done of the new tab's "Start here" card: which of its three steps are ticked and whether the card
// was closed. Pure functions over a plain value; `featured-store.ts` keeps it on disk beside the Featured choices.

export const STEP_IDS = ['app', 'eth', 'import'] as const
export type StepId = typeof STEP_IDS[number]

export interface StartHereState {
  readonly done: readonly StepId[]
  /** Set by Dismiss, or when every step the card showed was done. The card never comes back. */
  readonly closed: boolean
}

export const EMPTY_START: StartHereState = { done: [], closed: false }

/** The app the first step offers when the profile was not given one. */
export const DEFAULT_APP = { name: 'FreeTube', address: 'ipfs://freetube.orivonstack.eth' } as const

/** The `.eth` site the second step links to. */
export const ETH_SITE = 'ipfs://explore.orivonstack.eth'

/** Whether a tab's address is a `.eth` name loaded as the browser serves it (`https://<name>.eth/`), the page the second step waits for. */
export function isEthPageUrl (url: string): boolean {
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'https:' && parsed.port === '' && /^([a-z0-9-]+\.)+eth$/.test(parsed.hostname)
  } catch {
    return false
  }
}

/** What main knows when the page asks for the card. */
export interface StartHereFacts {
  readonly isPrivate: boolean
  /** The app a first-run package tag opened, or null. */
  readonly firstRunApp: { readonly name: string, readonly address: string } | null
  /** Another browser's profile was found on this computer. */
  readonly importAvailable: boolean
  /** The bundled uBlock Origin is installed and enabled in this profile. */
  readonly uboOn: boolean
}

export interface StartHereView {
  readonly app: { readonly name: string, readonly address: string }
  readonly site: string
  /** The steps the card shows, in order. */
  readonly steps: ReadonlyArray<{ readonly id: StepId, readonly done: boolean }>
  readonly uboOn: boolean
}

export function markStep (state: StartHereState, id: StepId): StartHereState {
  return state.done.includes(id) ? state : { ...state, done: [...state.done, id] }
}

export function closeStart (state: StartHereState): StartHereState {
  return state.closed ? state : { ...state, closed: true }
}

function shownSteps (facts: StartHereFacts): StepId[] {
  return facts.importAvailable ? [...STEP_IDS] : STEP_IDS.filter((id) => id !== 'import')
}

/** Every step the card would show is done. */
export function isComplete (state: StartHereState, facts: StartHereFacts): boolean {
  return shownSteps(facts).every((id) => state.done.includes(id))
}

/** The card, or null when it is not to be shown: a private session, a closed card, or nothing left to do. */
export function startHereView (state: StartHereState, facts: StartHereFacts): StartHereView | null {
  if (facts.isPrivate || state.closed || isComplete(state, facts)) return null
  return {
    app: facts.firstRunApp ?? DEFAULT_APP,
    site: ETH_SITE,
    steps: shownSteps(facts).map((id) => ({ id, done: state.done.includes(id) })),
    uboOn: facts.uboOn
  }
}

/** The state out of a parsed value; anything this version did not write is dropped, since a person can edit the file. */
export function parseStart (raw: unknown): StartHereState {
  const record = typeof raw === 'object' && raw !== null ? raw as Record<string, unknown> : {}
  const listed = Array.isArray(record['done']) ? record['done'] as unknown[] : []
  const done = STEP_IDS.filter((id) => listed.includes(id))
  return { done, closed: record['closed'] === true }
}
