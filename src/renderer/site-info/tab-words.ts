import type { SiteTunnel } from '../../main/permissions/site-info.js'

// What the tunnels page says when it is about a tab: every website the tab opens goes through the tunnel the tab carries (ADR-0101).
// Composed here, never from anything a site wrote. The tunnel of the person's own address is "your tunnel", as the button says.

export const TAB_TUNNEL_FAILED = 'The tunnel could not be changed for this tab.'
export const TAB_PICK_NOTE = 'Pick a tunnel and every site you open in this tab goes through it, until the tab is closed.'
export const TAB_FOLLOWING_NOTE = 'This tab follows the tunnel you set for all your browsing. Turn it off here to open sites directly in this tab only.'
export const SITE_OWN_DIRECT_NOTE = 'This site goes direct in every tab, because you chose that for the site.'
export const TAB_TUNNEL_PROFILE_NOTE = 'They keep their sign-ins in your tunnel profile, apart from your normal browsing.'
export const TAB_DIRECT_PROFILE_NOTE = 'A site that has a tunnel of its own keeps it. The others keep their sign-ins in your direct profile, apart from your normal browsing.'

export const ALWAYS_LABEL = 'Always use for this site'
export const ALWAYS_FAILED = 'The choice for this site could not be changed.'
export const ALWAYS_LINE_OFF = 'Keeps this choice after the tab closes.'
export const ALWAYS_LINE_ON = 'Saved for this site, in this tab and every other.'
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

/** Direct for this tab: said instead of an empty list of lit switches, so a tab that left the tunnel does not look like one that never had it. */
export function directTabNote (everywhere: boolean): string {
  return `Direct for this tab: the sites you open here do not use a tunnel${everywhere ? ', while the rest of your browsing does' : ''}.`
}

/**
 * What else the person is told about the tab, in order: what its choice means for the sites it opens, and where they keep their
 * sign-ins. A tab with no choice and switches that cannot be moved (a window held to Nym, settings that could not be read) is told
 * nothing here: the line that says why they are fixed already says all. So is a direct tab while the settings cannot be read: its
 * sites go through the one tunnel they all take then, and the line that says so is not about direct.
 */
export function tabNotes (tunnel: SiteTunnel, everywhere: boolean, fixed: boolean): readonly string[] {
  const choice = tunnel.tabChoice
  if (choice === 'direct') return tunnel.unreadable ? [] : [directTabNote(everywhere), TAB_DIRECT_PROFILE_NOTE]
  if (choice !== undefined) return [`Every site you open in this tab goes through ${tunnelWords(choice)}, until the tab is closed.`, TAB_TUNNEL_PROFILE_NOTE]
  if (fixed) return []
  // A website with an entry of its own and a tab with no choice: the page goes where the website was sent, not where the browser sends it.
  if (tunnel.always?.on === true) return [tunnel.via === null ? SITE_OWN_DIRECT_NOTE : `This site goes through ${tunnelWords(tunnel.via)} in every tab, because you chose it for the site.`]
  return [tunnel.via === null ? TAB_PICK_NOTE : TAB_FOLLOWING_NOTE]
}
