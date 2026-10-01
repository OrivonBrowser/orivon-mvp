// What the card says, as a fixed table: the only page-derived text on it is the address, which the page draws itself.

export interface SadTabText {
  readonly title: string
  readonly body: string
}

const CRASHED_TITLE = 'This page stopped working'

const MEMORY: SadTabText = { title: CRASHED_TITLE, body: 'This page ran out of memory. Closing other tabs may help.' }

/** Chromium's `render-process-gone` reasons that say more than "it died". Anything else, a reason added later included, gets the default. */
const BY_REASON: Readonly<Record<string, SadTabText>> = {
  oom: MEMORY,
  'memory-eviction': MEMORY,
  killed: { title: CRASHED_TITLE, body: "This page's process was ended." }
}

const DEFAULT_TEXT: SadTabText = { title: CRASHED_TITLE, body: 'Something went wrong while showing this page. Reloading usually fixes it.' }

export function textFor (reason: string | null): SadTabText {
  return (reason === null ? undefined : Object.hasOwn(BY_REASON, reason) ? BY_REASON[reason] : undefined) ?? DEFAULT_TEXT
}

export const UNRESPONSIVE_TEXT: SadTabText = { title: "This page isn't responding", body: 'You can wait for it or reload it.' }

/** The longest address the card carries; the page shortens it further to fit. */
export const ADDRESS_LIMIT = 200
