// shell-services.ts's `DevToolsService.appOf`, split out so the origin
// decision is testable as a pure function -- no `electron` import needed,
// just the shape of `WebContents` this actually reads.

/** The two `WebContents` fields `appOrigin` reads -- structural, so a test
 * needs no real `electron` object. */
export interface OpenerAware {
  readonly getURL: () => string
  readonly opener: { readonly url: string } | null
}

/**
 * The origin a DevTools prompt should treat `contents` as belonging to: its
 * own URL's origin, or -- for a popup an app opened, still at `about:blank`
 * until it navigates somewhere, so its own address gives no origin -- its
 * opener's. Reading `contents.opener.url` on an already-destroyed opener
 * throws (Electron); that is not a reason to fall through to "no origin at
 * all" as if there had never been an opener, so it is caught and treated the
 * same as a popup with none.
 */
export function appOrigin (originFromUrl: (url: string) => string | null, contents: OpenerAware): string | null {
  const direct = originFromUrl(contents.getURL())
  if (direct !== null) return direct
  if (contents.opener === null) return null
  let openerUrl: string
  try {
    openerUrl = contents.opener.url
  } catch {
    return null
  }
  return originFromUrl(openerUrl)
}
