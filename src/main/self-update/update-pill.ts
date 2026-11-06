// What the new-tab page's update button shows: the release on offer, while the person lets Orivon look and this is no kiosk.
// Plain values in and out, so the rule runs without the notice, the settings file or a page.
import { bareVersion } from './github-release-version.js'
import type { UpdateNotice, UpdateOffer } from './update-notice.js'

/** The two versions the button names, as the person reads them (no leading `v`). */
export interface UpdatePill {
  readonly latest: string
  readonly current: string
}

/**
 * The button's content, or null for none. It follows the offer, not whether the person was told of it: "Not now"
 * leaves it, and only the running version catching up (the offer is gone) or the setting going off removes it. A kiosk
 * is told through Settings only. A private session and a Microsoft Store install have no offer to show.
 */
export function updatePillOf (offer: UpdateOffer | null, checkOn: boolean, kiosk: boolean): UpdatePill | null {
  if (offer === null || !checkOn || kiosk) return null
  return { latest: bareVersion(offer.latest), current: bareVersion(offer.current) }
}

/** The part of the settings store the button follows. */
export interface UpdatePillSettings {
  readonly get: (key: 'updates.check') => boolean
  readonly onChange: (listener: (change: { readonly key: string }) => void) => () => void
}

/** What the new-tab IPC needs of the update: what to show, when that changes, and what a press does. */
export interface NewTabUpdate {
  readonly shown: () => UpdatePill | null
  /** Calls `listener` when what `shown` answers is not what it was; answers the removal. */
  readonly onChange: (listener: () => void) => () => void
  /** The press: asks about the release on offer again, in the window in use. Never throws. */
  readonly ask: () => void
}

const sameShown = (a: UpdatePill | null, b: UpdatePill | null): boolean => a?.latest === b?.latest && a?.current === b?.current

export function newTabUpdate (notice: Pick<UpdateNotice, 'offer' | 'onChange' | 'askAgain'>, settings: UpdatePillSettings, kiosk: boolean): NewTabUpdate {
  const shown = (): UpdatePill | null => updatePillOf(notice.offer(), settings.get('updates.check'), kiosk)
  return {
    shown,
    onChange: (listener) => {
      // The notice also reports a release going from not told to told, which the button does not show.
      let last = shown()
      const changed = (): void => {
        const now = shown()
        if (sameShown(last, now)) return
        last = now
        listener()
      }
      const stopOffer = notice.onChange(changed)
      const stopSetting = settings.onChange(({ key }) => { if (key === 'updates.check') changed() })
      return () => { stopOffer(); stopSetting() }
    },
    ask: () => { void notice.askAgain() }
  }
}
