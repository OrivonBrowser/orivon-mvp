import type { SiteTunnel } from '../../main/permissions/site-info.js'

// What the tunnels page says when it is about a tab: every website the tab opens goes through the tunnel the tab carries (ADR-0101).
// Composed here, never from anything a site wrote. The tunnel of the person's own address is "your tunnel", as the button says.

export const TAB_TUNNEL_FAILED = 'The tunnel could not be changed for this tab.'
export const TAB_PICK_NOTE = 'Pick a tunnel for the sites you open in this tab, until it closes.'
export const TAB_FOLLOWING_NOTE = 'This tab follows your browser-wide tunnel. Turn it off here for this tab only.'
export const TAB_DIRECT_NOTE = 'Sites in this tab go direct. A site saved to a tunnel keeps it.'
export const SITE_OWN_DIRECT_NOTE = 'This site goes direct in every tab.'

export const ALWAYS_LABEL = 'Always use for this site'
export const ALWAYS_FAILED = 'The choice for this site could not be changed.'
export const ALWAYS_LINE_OFF = 'Keeps this choice after the tab closes.'
export const ALWAYS_LINE_ON = 'Saved for this site, in every tab.'
export const ALWAYS_LINE_NOTHING = 'Pick a tunnel to keep it for this site.'
/** A switch that cannot be moved keeps nothing to promise: the notes above it say why. */
export const ALWAYS_LINE_HELD = ''

/** The name of the tunnel in a sentence about the tab. */
function tunnelWords (kind: 'nym' | 'socks5'): string {
  return kind === 'nym' ? 'Nym' : 'your tunnel'
}

/** The website keeps one tunnel and this tab goes through another (the tab's choice wins): the switch is on for the one saved, and the line names both. */
export function alwaysLineOther (saved: 'nym' | 'socks5' | null, via: 'nym' | 'socks5' | null): string {
  const kept = saved === null ? 'Saved for this site: direct.' : `Saved for this site: ${tunnelWords(saved)}.`
  return via === null ? `${kept} This tab goes direct.` : `${kept} This tab uses ${tunnelWords(via)}.`
}

/**
 * What else the person is told about the tab, in one line at most: what its choice means for the sites it opens, with where their
 * sign-ins are kept when a tunnel is chosen. A tab with no choice and switches that cannot be moved (a window held to Nym, settings
 * that could not be read) is told nothing here: the line that says why they are fixed already says all. So is a direct tab while the
 * settings cannot be read: its sites go through the one tunnel they all take then, and the line that says so is not about direct.
 */
export function tabNotes (tunnel: SiteTunnel, fixed: boolean): readonly string[] {
  const choice = tunnel.tabChoice
  if (choice === 'direct') return tunnel.unreadable ? [] : [TAB_DIRECT_NOTE]
  if (choice !== undefined) return [`Sites in this tab go through ${tunnelWords(choice)} until the tab closes, with their sign-ins kept apart.`]
  if (fixed) return []
  // A website with an entry of its own and a tab with no choice: the page goes where the website was sent, not where the browser sends it.
  if (tunnel.always?.on === true) return [tunnel.via === null ? SITE_OWN_DIRECT_NOTE : `This site uses ${tunnelWords(tunnel.via)} in every tab.`]
  return [tunnel.via === null ? TAB_PICK_NOTE : TAB_FOLLOWING_NOTE]
}
