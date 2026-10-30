// What main tells the link bubble's page, and the text it shows. Types only on the page's side: the page imports
// this file for its shapes, never a value.

/** The overlay's name, also its page key. */
export const LINK_STATUS_OVERLAY = 'link-status'

/** An address is cut to this many characters before it crosses to the page: a `data:` link can be megabytes, and the bubble shows 600 pixels of it at most. */
export const MAX_TEXT_LENGTH = 1024

export type BubbleSide = 'left' | 'right'

/** How far the bubble's view reaches past its visible part at each edge that is the window's: the corners that are not the bubble's rounded one are rounded off the screen. */
export interface BubbleInset { readonly left: number, readonly right: number, readonly bottom: number }

/** What the page draws: the text, which corner it is in, and how far its view reaches past what shows. `seq` names this text, and the page's measurement of it carries it back. */
export interface LinkStatusView {
  readonly seq: number
  readonly text: string
  readonly side: BubbleSide
  readonly inset: BubbleInset
}

/** The address as Electron gives it, cut to `MAX_TEXT_LENGTH`, and never ending on half of a character. */
export function linkText (url: string): string {
  if (url.length <= MAX_TEXT_LENGTH) return url
  const cut = url.slice(0, MAX_TEXT_LENGTH)
  const last = cut.charCodeAt(cut.length - 1)
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut
}
