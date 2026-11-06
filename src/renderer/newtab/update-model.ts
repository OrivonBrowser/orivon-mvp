// What the page's update button says, out of what main answered. Pure, so the shapes it refuses run under plain vitest.

/** A version as main sends it, without a leading `v`: three numbers, then whatever a pre-release or build adds. */
const VERSION = /^\d+\.\d+\.\d+[0-9A-Za-z.+-]{0,40}$/

export interface PageUpdate {
  readonly latest: string
  readonly current: string
}

/** The release the button names, or null when main says there is none or answers anything that is not two versions: the button stays away. */
export function readUpdate (answer: unknown): PageUpdate | null {
  if (typeof answer !== 'object' || answer === null) return null
  const { latest, current } = answer as { latest?: unknown, current?: unknown }
  if (typeof latest !== 'string' || typeof current !== 'string' || !VERSION.test(latest) || !VERSION.test(current)) return null
  return { latest, current }
}

/** The button's tooltip and accessible name. */
export const updateLabel = (update: PageUpdate): string => `Orivon ${update.latest} is available. You have ${update.current}.`
