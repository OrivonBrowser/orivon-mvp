// Whether a page's site has sound switched off. `signals/audio.ts` asks it
// whenever it decides a tab's mute, so the answer has to be reachable without
// a window or a store in hand: the installer binds the rule at start, and
// before then no site is silenced. No `electron` import.
type SoundRule = (pageUrl: string, openerUrl: () => string | undefined) => boolean

let rule: SoundRule = () => false

export const siteSound = {
  bind (next: SoundRule): void { rule = next },
  /** True when the page at `pageUrl` is on a site told to be silent; a blank or `blob:` page is judged by the page that opened it (`openerUrl`). */
  blocked (pageUrl: string, openerUrl: () => string | undefined = () => undefined): boolean {
    try { return rule(pageUrl, openerUrl) } catch (error) { console.error('[site-sound] the rule failed:', error); return false }
  }
}
