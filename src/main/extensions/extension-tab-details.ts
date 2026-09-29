// assignTabDetails's own mapping (extension-host.ts), pulled out so it is
// unit-tested without mocking Electron or extension-host.ts's virtual
// specifier imports (electron-chrome-extensions-lib.d.ts's own header says
// why those exist). No Electron import: pure, per src/main/extensions/
// README.md's suffix rule for "the decision".
export interface OrivonTabDetails {
  pinned: boolean
  favIconUrl?: string
}

/** `details` (the library's own base, built from the real WebContents --
 * title/url/status/audible are already right) gets Orivon's own captured
 * favicon in place of whatever the page itself last declared, and `pinned`
 * explicitly, since Orivon has no concept of a pinned tab yet. `favicon` is
 * `null` for a tab this host cannot find (not yet tracked, or none
 * captured) -- left alone rather than cleared, so a value the library's own
 * default already set survives. */
export function applyOrivonTabDetails (details: OrivonTabDetails, favicon: string | null): void {
  details.pinned = false
  if (favicon !== null) details.favIconUrl = favicon
}
