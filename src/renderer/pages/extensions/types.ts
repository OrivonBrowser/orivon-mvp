// What a view, a details section and a card badge are, and what the page hands them.
import type { DetailsPayload, ExtensionRow } from './state.js'

export interface PageContext {
  /** One request to the extensions domain in main, `type` first. */
  request: <T>(type: string, body?: object) => Promise<T>
  /** A path of this page, such as `/details?id=<id>`. */
  navigate: (path: string) => void
  /** Draws the view again with fresh data, keeping what it shows until the data arrives. */
  refresh: () => void
  developerMode: boolean
  isPrivate: boolean
}

export interface ExtensionView {
  /** Fills `root`; called again on the same `root` for a refresh. */
  render: (root: HTMLElement, ctx: PageContext) => void
}

export interface DetailSection {
  id: string
  title: string
  /** Sections run top to bottom by this number; the first is 10. */
  order: number
  /** Null leaves the section out. */
  render: (details: DetailsPayload, ctx: PageContext) => HTMLElement | null
}

export interface CardBadge {
  /** Null leaves the badge out. */
  render: (row: ExtensionRow, ctx: PageContext) => HTMLElement | null
}
