// What the prompt reads from the show payload main sends, checked here because a page trusts nothing it is handed.

export interface Offer { kind: 'save' | 'update', origin: string, username: string }

/** How long "Password saved" stays before the prompt closes. */
export const SAVED_MS = 1500

export function offerFrom (payload: unknown): Offer | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined
  const { kind, origin, username } = payload as Record<string, unknown>
  if ((kind !== 'save' && kind !== 'update') || typeof origin !== 'string' || typeof username !== 'string') return undefined
  return { kind, origin, username }
}
