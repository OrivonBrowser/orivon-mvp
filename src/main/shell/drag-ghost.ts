// The preview of a dragged tab when no window can follow the pointer (local-pointer.ts): the page's thumbnail,
// or a tab-shaped chip while there is none, drawn as a view inside the window the drag started in. It shows
// while the pointer is over that window's page and is taken out of the window everywhere else, where the
// pointer's own cursor is all there is to see.
import { nativeTheme, WebContentsView } from 'electron'
import type { View } from 'electron'
import { attachShown } from './attach-view.js'
import { chipHtml, CHIP_HEIGHT, CHIP_WIDTH, thumbnailHtml } from './tear-drag.js'
import type { Bounds } from './tab-types.js'

export class DragGhost {
  private readonly view: WebContentsView
  private thumbnail: string | null = null
  private shape: { width: number, height: number }
  private shown = false
  private gone = false

  /** `thumbnail` resolves once the page has been captured (or to null when it cannot be). */
  constructor (
    private readonly parent: View,
    private readonly size: { width: number, height: number },
    private readonly title: string,
    thumbnail: Promise<string | null>
  ) {
    this.shape = { width: CHIP_WIDTH, height: CHIP_HEIGHT }
    // Static markup this file builds, never a page with anything to run: no script, no preload, no navigation.
    this.view = new WebContentsView({ webPreferences: { contextIsolation: true, javascript: false, sandbox: true } })
    const { webContents } = this.view
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    webContents.on('will-navigate', (event) => { event.preventDefault() })
    webContents.on('will-redirect', (event) => { event.preventDefault() })
    this.view.setBackgroundColor('#00000000')
    this.render()
    void thumbnail.then((dataUrl) => {
      if (this.gone || dataUrl === null) return
      this.thumbnail = dataUrl
      this.shape = this.size
      this.render()
    })
  }

  private render (): void {
    const html = this.thumbnail === null
      ? chipHtml(this.title, nativeTheme.shouldUseDarkColors)
      : thumbnailHtml(this.thumbnail, this.size.width, this.size.height)
    void this.view.webContents.loadURL(`data:text/html,${encodeURIComponent(html)}`)
  }

  /** Where the ghost sits for a pointer at `at` (the window's own coordinates), or null: not shown there. */
  follow (at: { x: number, y: number } | null, offset: number): void {
    if (this.gone) return
    if (at === null) {
      this.hide()
      return
    }
    const bounds: Bounds = { x: Math.round(at.x + offset), y: Math.round(at.y + offset), width: this.shape.width, height: this.shape.height }
    // On top of every other view, including one added since the drag began.
    if (!this.shown || this.parent.children.at(-1) !== this.view) {
      if (this.shown) this.parent.removeChildView(this.view)
      attachShown(this.parent, this.view)
      this.shown = true
    }
    this.view.setBounds(bounds)
  }

  hide (): void {
    if (!this.shown) return
    this.parent.removeChildView(this.view)
    this.shown = false
  }

  dispose (): void {
    if (this.gone) return
    this.gone = true
    try {
      this.hide()
    } catch {
      // The window closed first: the view went with it.
    }
    if (!this.view.webContents.isDestroyed()) this.view.webContents.close()
  }
}
