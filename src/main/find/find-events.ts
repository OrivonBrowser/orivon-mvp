// What main tells the find bar's page, and what the page asks of main. Types
// only: the page (src/renderer/overlay/find/) and the handler share them.

/** What the bar shows when it opens. `fresh` is false when it was open already and only took focus back. */
export interface FindShown { readonly query: string, readonly matchCase: boolean, readonly fresh: boolean }

/** Events main sends to the open bar. */
export type FindEvent =
  | { readonly type: 'result', readonly active: number, readonly total: number }
  /** The page is loading another document: the count no longer describes it. */
  | { readonly type: 'reset' }

/** The most a query may hold: longer text is refused, never cut. */
export const MAX_QUERY_LENGTH = 512

export type FindRequest =
  | { readonly type: 'query', readonly text: string, readonly matchCase: boolean }
  | { readonly type: 'step', readonly forward: boolean }

/** A request from the page as this side accepts it; anything else is ignored. */
export function asFindRequest (command: unknown): FindRequest | undefined {
  if (typeof command !== 'object' || command === null) return undefined
  const { type, text, matchCase, forward } = command as Record<string, unknown>
  if (type === 'query' && typeof text === 'string' && text.length <= MAX_QUERY_LENGTH && typeof matchCase === 'boolean') return { type, text, matchCase }
  if (type === 'step' && typeof forward === 'boolean') return { type, forward }
  return undefined
}

/** The chrome's show payload: the step a closed-bar Find next asked for, if any. */
export function asShowStep (payload: unknown): boolean | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { step } = payload as Record<string, unknown>
  return typeof step === 'boolean' ? step : undefined
}
