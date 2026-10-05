// Whether a judged score of some content counts at the address it is shown at (ADR-0055).
// The manifest is a leaf of the content address, so a provider's judgement of the content
// covers the `domain` its manifest names; the judgement counts only at that host. Pure:
// the caller reads the manifest and hands over what it found.

/** What the caller found when it looked for the manifest of the content shown at an address. */
export type HomeFacts =
  | { readonly kind: 'app', readonly domain: string | undefined }
  /** A verified absence: the content has no manifest, so it is a website, not an app. */
  | { readonly kind: 'website' }
  /** The manifest could not be read or parsed. Nothing is borrowed from a judgement. */
  | { readonly kind: 'unread' }

/**
 * `bound`: the manifest names this host. `other-home`: it names another. `no-home`: it names
 * none, or could not be read. `not-applicable`: no manifest exists.
 */
export type DomainBinding = 'bound' | 'other-home' | 'no-home' | 'not-applicable'

export function domainBinding (host: string, facts: HomeFacts): DomainBinding {
  switch (facts.kind) {
    case 'website': return 'not-applicable'
    case 'unread': return 'no-home'
    case 'app':
      if (facts.domain === undefined) return 'no-home'
      return facts.domain === host ? 'bound' : 'other-home'
  }
}

/** A judged level is shown only where it is bound, or where there is no app for it to be about. */
export function judgedLevelCounts (binding: DomainBinding): boolean {
  return binding === 'bound' || binding === 'not-applicable'
}

/** The host of a canonical origin, or the empty string for text that is no URL. */
export function originHost (origin: string): string {
  try {
    return new URL(origin).hostname
  } catch {
    return ''
  }
}

/** What an app says about where it lives, when that is somewhere other than here. */
export function homeLine (host: string, domain: string | undefined): string | undefined {
  return domain === undefined || domain === host ? undefined : `This app names ${domain} as its home.`
}

/** Why a provider's judgement is not counted at this address, in words for the Web3 Score page. */
export function judgedElsewhereNote (provider: string, binding: DomainBinding, domain: string | undefined): string {
  const where = binding === 'other-home' && domain !== undefined
    ? `its manifest names ${domain} as its home, not this address`
    : 'its manifest names no home, or could not be read'
  return `${provider} judged these files, but ${where}, so the judged level is not counted here and the level shown is what this browser observed.`
}
