import type { WebContentsView } from 'electron'
import type { TabRecord } from './tab-types.js'

/** Whether a page opened `contents` and still holds a link to it. A link with a target implies `noopener`, so a tab it opens has none; the opening page can cut the link of a popup with `w.opener = null` and keep writing into it. */
export function hasOpener (contents: { readonly opener?: unknown }): boolean {
  return (contents.opener ?? null) !== null
}

/**
 * Records on `record` that `view`, a popup Chromium made for a page, began with an opener: the page then writes into the popup's
 * empty document until its website answers, and cutting the link afterwards does not stop that. Chromium may set the opener only after
 * the adoption, so it is read then and again as the popup's first main-frame navigation starts, which the opening page cannot get ahead
 * of. `changed` runs when the record gains it.
 */
export function watchPopupOpener (view: WebContentsView, record: Pick<TabRecord, 'popupWithOpener'>, changed: () => void): void {
  const { webContents } = view
  const mark = (): void => {
    if (record.popupWithOpener !== undefined || !hasOpener(webContents)) return
    record.popupWithOpener = view
    changed()
  }
  mark()
  const onStart = (details: { readonly isMainFrame: boolean }): void => {
    if (!details.isMainFrame) return
    webContents.off('did-start-navigation', onStart)
    mark()
  }
  webContents.on('did-start-navigation', onStart)
}

/** Whether the tab is a popup a page opened and wrote, or can write, into: it holds its opener now, or began with one in the view it still shows. */
export function isPageOpenedPopup (record: Pick<TabRecord, 'view' | 'popupWithOpener'> | undefined, contents: { readonly opener?: unknown } | undefined): boolean {
  if (contents !== undefined && hasOpener(contents)) return true
  return record?.popupWithOpener !== undefined && record.popupWithOpener === record.view
}
