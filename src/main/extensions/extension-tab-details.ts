// assignTabDetails's own mapping (extension-host.ts), pulled out so it is
// unit-tested without mocking Electron or extension-host.ts's virtual
// specifier imports (electron-chrome-extensions-lib.d.ts's own header says
// why those exist). No Electron import: pure, per src/main/extensions/
// README.md's suffix rule for "the decision".
export interface OrivonTabDetails {
  pinned: boolean
  favIconUrl?: string
  discarded?: boolean
  url?: string
  title?: string
}

/** What a sleeping tab kept: its blank view has no address, title or icon of its own. */
export interface SleepingDetails {
  readonly url: string
  readonly title: string
  readonly favicon: string | null
}

/** `details` (the library's own base, built from the real WebContents --
 * title/url/status/audible/mutedInfo are already right) gets Orivon's own
 * captured favicon in place of whatever the page itself last declared, and
 * `pinned` from the tab's record, which the page cannot know. `favicon` is
 * `null` for a tab this host cannot find (not yet tracked, or none
 * captured) -- left alone rather than cleared, so a value the library's own
 * default already set survives; the same tab reads as unpinned. */
export function applyOrivonTabDetails (details: OrivonTabDetails, favicon: string | null, pinned: boolean, sleeping?: SleepingDetails | null): void {
  details.pinned = pinned
  if (favicon !== null) details.favIconUrl = favicon
  if (sleeping == null) return
  // `discarded`, as Chrome reports a tab whose page was dropped; the address and title are the ones it will wake to.
  details.discarded = true
  details.url = sleeping.url
  details.title = sleeping.title
  if (sleeping.favicon !== null) details.favIconUrl = sleeping.favicon
}
