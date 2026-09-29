// The floating preview a tab shows once it has left its own strip: a small,
// click-through window that follows the pointer -- a thumbnail of the page
// over open space, or a tab-shaped chip once the pointer is over another
// window's own strip, which then draws the insertion line the drop would use
// (`crossWindowTargetFor`, tab-move.ts -- the same computation, so the mark
// and the drop never disagree about where a tab would land).
//
// One instance for the whole process (shell-services.ts), not one per
// window: only one tab can be mid-drag at a time, and where it ends up can
// be any window, not just the one it started in.
//
// A frameless, transparent, non-focusable, always-on-top, click-through
// `BaseWindow` moved by `setPosition` on every poll tick does not disturb the
// dragging view's own pointer capture, and capturing a tab's page is cheap
// enough (tens of milliseconds, cold or warm) to run on every drag without
// the window itself feeling laggy.
import { BaseWindow, nativeTheme, screen, WebContentsView } from 'electron'
import type { NativeImage } from 'electron'
import { SHELL_EVENT_CHANNEL } from '../channels.js'
import { inTop, crossWindowTargetFor } from './tab-move.js'
import { captureTabPage } from './tab-view.js'
import type { ShellWindow } from './window-registry.js'

const POLL_MS = 16 // ~60Hz: fast enough to track the pointer smoothly, cheap enough to run every drag
const MAX_PREVIEW_WIDTH = 480
const PREVIEW_SHARE = 1 / 3
const CHIP_WIDTH = 168
const CHIP_HEIGHT = 32
/** Offset from the real cursor, so the preview trails it rather than sitting exactly under it (and hiding it). */
const CURSOR_OFFSET = 16

/** How big the floating thumbnail is: about a third of the source window's own page, capped so a very wide
 * window does not produce an oversized ghost. Pure, so the sizing rule is tested without a window. */
export function previewSizeFor (sourceWidth: number, sourceHeight: number): { width: number, height: number } {
  const width = Math.max(1, Math.min(MAX_PREVIEW_WIDTH, Math.round(sourceWidth * PREVIEW_SHARE)))
  const height = Math.max(1, Math.round(width * sourceHeight / Math.max(1, sourceWidth)))
  return { width, height }
}

function escapeHtml (text: string): string {
  return text.replace(/[&<>"]/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[char] ?? char))
}

function thumbnailHtml (dataUrl: string, width: number, height: number): string {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden}
img{display:block;width:${String(width)}px;height:${String(height)}px;object-fit:cover;border-radius:10px;opacity:0.88;box-shadow:0 8px 24px rgba(0,0,0,0.35)}
</style></head><body><img src="${dataUrl}"></body></html>`
}

// Same surface/ink relationship as src/renderer/style.css's --wsurface/--wink tokens (the active tab's own
// background), so the chip reads as a small tab rather than a colour the rest of the chrome never uses.
const CHIP_SURFACE_DARK = '#2b2c31'
const CHIP_SURFACE_LIGHT = '#f2f2f7'
const CHIP_INK_DARK = '#e6e7e8'
const CHIP_INK_LIGHT = 'rgba(0, 0, 0, 0.90)'

function chipHtml (title: string, dark: boolean): string {
  const surface = dark ? CHIP_SURFACE_DARK : CHIP_SURFACE_LIGHT
  const ink = dark ? CHIP_INK_DARK : CHIP_INK_LIGHT
  return `<!doctype html><html><head><meta charset="utf-8"><style>
html,body{margin:0;background:transparent;overflow:hidden;font-family:system-ui,sans-serif}
.chip{width:${String(CHIP_WIDTH - 8)}px;height:${String(CHIP_HEIGHT - 8)}px;margin:4px;border-radius:8px;background:${surface};color:${ink};
display:flex;align-items:center;padding:0 10px;font-size:12px;box-shadow:0 6px 16px rgba(0,0,0,0.35);opacity:0.92;
overflow:hidden;white-space:nowrap;text-overflow:ellipsis}
</style></head><body><div class="chip">${escapeHtml(title)}</div></body></html>`
}

export class TearDragController {
  private win: BaseWindow | null = null
  private view: WebContentsView | null = null
  private timer: ReturnType<typeof setInterval> | null = null
  private mode: 'thumbnail' | 'chip' | null = null
  private markedWindow: ShellWindow | null = null
  private markedIndex: number | null = null
  private source: ShellWindow | null = null
  private tabId: string | null = null
  private thumbnail: string | null = null
  private title = ''
  private size = { width: 0, height: 0 }
  private inZone = false
  private topHeight = 0
  /** A capture started at the drag's press, before any tear -- so the thumbnail is usually already in hand
   * by the time the tab actually leaves the strip, rather than starting a ~57ms-cold capture at that moment. */
  private warming: { tabId: string, promise: Promise<string | null> } | null = null

  constructor (private readonly windows: () => readonly ShellWindow[]) {}

  /** A drag just started (tab-drag.ts's own `begin()`, before any tear-out): get the capture going early. */
  prewarm (source: ShellWindow, tabId: string): void {
    const bounds = source.window.getContentBounds()
    const size = previewSizeFor(bounds.width, bounds.height)
    this.warming = {
      tabId,
      promise: captureTabPage(source.tabs.liveWebContents(tabId)).then((image) => imageToDataUrl(image, size))
    }
  }

  /** The dragged tab is out of its strip (or moved while already out). `inSplitZone`: a same-window split
   * preview is showing instead, so neither the floating preview nor a cross-window mark shows alongside it
   * (never both at once). Safe to call on every drag tick -- capture and window creation happen once. */
  update (source: ShellWindow, tabId: string, inSplitZone: boolean, topHeight: number): void {
    this.inZone = inSplitZone
    this.topHeight = topHeight
    if (this.source === source && this.tabId === tabId) return
    this.begin(source, tabId)
  }

  /** The drag is over, or the tab is back inside its own strip: nothing left to show or track. */
  clear (): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    if (this.win !== null && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    this.view = null
    this.mode = null
    this.source = null
    this.tabId = null
    this.thumbnail = null
    this.warming = null
    this.clearMark()
  }

  dispose (): void { this.clear() }

  private clearMark (): void {
    const marked = this.markedWindow
    this.markedWindow = null
    this.markedIndex = null
    if (marked !== null && !marked.window.isDestroyed() && !marked.chrome.webContents.isDestroyed()) {
      marked.chrome.webContents.send(SHELL_EVENT_CHANNEL, { type: 'dragMarkClear' })
    }
  }

  private begin (source: ShellWindow, tabId: string): void {
    this.source = source
    this.tabId = tabId
    const tab = source.tabs.getState().tabs.find((candidate) => candidate.id === tabId)
    this.title = tab === undefined || tab.title.length === 0 ? 'New Tab' : tab.title
    const bounds = source.window.getContentBounds()
    this.size = previewSizeFor(bounds.width, bounds.height)

    const warm = this.warming?.tabId === tabId ? this.warming.promise : captureTabPage(source.tabs.liveWebContents(tabId)).then((image) => imageToDataUrl(image, this.size))
    void warm.then((dataUrl) => {
      if (this.tabId !== tabId || dataUrl === null) return // the drag may already be over, or a different tab's, by the time this resolves
      this.thumbnail = dataUrl
      if (this.mode !== 'chip') this.render()
    })

    this.win = new BaseWindow({
      width: this.size.width,
      height: this.size.height,
      x: -this.size.width,
      y: -this.size.height,
      frame: false,
      transparent: true,
      hasShadow: true,
      alwaysOnTop: true,
      focusable: false,
      skipTaskbar: true,
      show: false
    })
    // No preload, sandboxed, contextIsolation on, and javascript off outright: its documents are static
    // markup this file builds itself (a thumbnail `<img>`, a chip's `<div>`), never a page with anything to
    // run. `setWindowOpenHandler`/`will-navigate`/`will-redirect` are refused all the same, defence in depth
    // against a future change to what this view loads -- its own `loadURL` calls below are not navigations
    // Electron fires these events for.
    this.view = new WebContentsView({ webPreferences: { contextIsolation: true, javascript: false, sandbox: true } })
    const { webContents } = this.view
    webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    webContents.on('will-navigate', (event) => { event.preventDefault() })
    webContents.on('will-redirect', (event) => { event.preventDefault() })
    // A transparent BaseWindow paints its child view's own background
    // opaque unless told otherwise (electron.d.ts's own note on `transparent`).
    this.view.setBackgroundColor('#00000000')
    this.win.contentView.addChildView(this.view)
    this.view.setBounds({ x: 0, y: 0, width: this.size.width, height: this.size.height })
    // Never the drop target itself, and never able to take a click or a keystroke meant for whatever is under it.
    this.win.setIgnoreMouseEvents(true)
    this.win.showInactive()
    this.mode = 'thumbnail'
    this.render()
    this.timer = setInterval(() => { this.tick() }, POLL_MS)
  }

  private tick (): void {
    const win = this.win
    const source = this.source
    if (win === null || win.isDestroyed() || source === null || source.window.isDestroyed() || this.tabId === null) { this.clear(); return }
    const point = screen.getCursorScreenPoint()

    // A split preview is showing instead (never both at once), or the pointer is back over this window's
    // own strip and toolbar, where letting go does nothing (window-actions.ts's own dropTab): parked
    // off-screen, not destroyed, so it reappears at once, with no new capture, if the pointer moves on.
    if (this.inZone || inTop(source.window.getBounds(), point, this.topHeight)) {
      win.setPosition(-this.size.width, -this.size.height)
      this.clearMark()
      return
    }

    const target = crossWindowTargetFor(source, point, this.windows(), this.topHeight)
    if (target === null) {
      this.clearMark()
    } else if (target.window !== this.markedWindow) {
      this.clearMark() // a different window than the one last marked, if any
      this.markedWindow = target.window
      this.markedIndex = target.index
      target.window.chrome.webContents.send(SHELL_EVENT_CHANNEL, { type: 'dragMark', index: target.index })
    } else if (target.index !== this.markedIndex) {
      // Same window, a different place in its strip: no clear/resend cycle, just the new index.
      this.markedIndex = target.index
      target.window.chrome.webContents.send(SHELL_EVENT_CHANNEL, { type: 'dragMark', index: target.index })
    }

    const wantChip = target !== null
    if ((wantChip && this.mode !== 'chip') || (!wantChip && this.mode !== 'thumbnail')) {
      this.mode = wantChip ? 'chip' : 'thumbnail'
      this.render()
    }
    const size = this.mode === 'chip' ? { width: CHIP_WIDTH, height: CHIP_HEIGHT } : this.size
    const current = win.getContentBounds()
    if (current.width !== size.width || current.height !== size.height) {
      win.setContentSize(size.width, size.height)
      this.view?.setBounds({ x: 0, y: 0, width: size.width, height: size.height })
    }
    win.setPosition(point.x + CURSOR_OFFSET, point.y + CURSOR_OFFSET)
  }

  private render (): void {
    if (this.view === null) return
    if (this.mode === 'chip') {
      void this.view.webContents.loadURL(`data:text/html,${encodeURIComponent(chipHtml(this.title, nativeTheme.shouldUseDarkColors))}`)
    } else if (this.thumbnail !== null) {
      void this.view.webContents.loadURL(`data:text/html,${encodeURIComponent(thumbnailHtml(this.thumbnail, this.size.width, this.size.height))}`)
    }
  }
}

function imageToDataUrl (image: NativeImage | null, size: { width: number, height: number }): string | null {
  if (image === null) return null
  try {
    return image.resize(size).toDataURL()
  } catch {
    return null
  }
}
