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
import { attachShown } from './attach-view.js'
import { refreshStripLayout, stripCentresFor } from './strip-centres.js'
import { inTop, crossWindowTargetFor } from './tab-move.js'
import { captureTabPage } from './tab-view.js'
import type { ShellWindow } from './window-registry.js'

const POLL_MS = 16 // ~60Hz: fast enough to track the pointer smoothly, cheap enough to run every drag
const MAX_PREVIEW_WIDTH = 480
const PREVIEW_SHARE = 1 / 3
/** The least time between two reads of a strip's layout whose last read no longer fits its tabs. */
const STRIP_READ_RETRY_MS = 250
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
  private nextRead = 0
  /** A capture started at the drag's press, before any tear -- so the thumbnail is usually already in hand
   * by the time the tab actually leaves the strip, rather than starting a ~57ms-cold capture at that moment. */
  private warming: { tabId: string, promise: Promise<string | null> } | null = null

  constructor (private readonly windows: () => readonly ShellWindow[]) {}

  /** A drag just started (tab-drag.ts's own `begin()`, before any tear-out): get the capture going early. */
  prewarm (source: ShellWindow, tabId: string): void {
    const bounds = source.window.getContentBounds()
    const size = previewSizeFor(bounds.width, bounds.height)
    for (const other of this.windows()) if (other !== source) void refreshStripLayout(other)
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

  /** The drag has genuinely ended (window-actions.ts's own `endTabDrag`, on a drop -- inside the
   * strip or out -- or a cancel): nothing left to show or track. Never called for an in-strip move
   * of a drag still under way; that only hides the window (`tick()`'s own `inTop` check) and keeps
   * everything else, including the warm capture, alive in case the tab tears out after all. */
  clear (): void {
    this.destroyWindow()
    this.source = null
    this.tabId = null
    this.warming = null
    this.clearMark()
  }

  dispose (): void { this.clear() }

  /** Tears down the floating-preview window and its poll, without touching `warming`, `source` or
   * `tabId` -- the part `clear()` shares with `begin()`, which needs the same teardown for
   * whatever window a previous drag left live, but must keep the new drag's own warm capture. */
  private destroyWindow (): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
    // A BaseWindow does not close the views it holds: the preview's page would live on in a renderer of its own.
    if (this.view !== null && !this.view.webContents.isDestroyed()) this.view.webContents.close()
    if (this.win !== null && !this.win.isDestroyed()) this.win.destroy()
    this.win = null
    this.view = null
    this.mode = null
    this.thumbnail = null
  }

  private clearMark (): void {
    const marked = this.markedWindow
    this.markedWindow = null
    this.markedIndex = null
    if (marked !== null && !marked.window.isDestroyed() && !marked.chrome.webContents.isDestroyed()) {
      marked.chrome.webContents.send(SHELL_EVENT_CHANNEL, { type: 'dragMarkClear' })
    }
  }

  private begin (source: ShellWindow, tabId: string): void {
    // A previous drag's window and poll, if update() is ever asked to begin a new one (a different
    // source or tab) before that one was torn down: never leak it, and never race two intervals.
    this.destroyWindow()
    this.clearMark()
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

    // Created hidden, with no position yet: `hide()`/`showInactive()` (tick()'s own `inTop` check
    // below), never negative screen coordinates, is how this parks between the strip and open space
    // -- a monitor placed left of or above the primary makes negative coordinates a real, visible
    // place, which off-screen parking was never meant to be. The first tick(), called once
    // synchronously right after this, gives it its first real position before it is ever shown.
    this.win = new BaseWindow({
      width: this.size.width,
      height: this.size.height,
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
    attachShown(this.win.contentView, this.view)
    this.view.setBounds({ x: 0, y: 0, width: this.size.width, height: this.size.height })
    // Never the drop target itself, and never able to take a click or a keystroke meant for whatever is under it.
    this.win.setIgnoreMouseEvents(true)
    this.mode = 'thumbnail'
    this.render()
    this.timer = setInterval(() => { this.tick() }, POLL_MS)
    this.tick() // positions (and shows, unless already back over the source window) before the first paint
  }

  private tick (): void {
    const win = this.win
    const source = this.source
    if (win === null || win.isDestroyed() || source === null || source.window.isDestroyed() || this.tabId === null) { this.clear(); return }
    const point = screen.getCursorScreenPoint()

    // A split preview is showing instead (never both at once), or the pointer is back over this window's
    // own strip and toolbar, where letting go does nothing (window-actions.ts's own dropTab): hidden, not
    // destroyed, so it reappears at once, with no new capture, if the pointer moves on -- never parked at
    // negative coordinates, which a monitor left of or above the primary makes a real, visible place.
    if (this.inZone || inTop(source.window.getBounds(), point, this.topHeight)) {
      if (win.isVisible()) win.hide()
      this.clearMark()
      return
    }
    if (!win.isVisible()) win.showInactive()

    const target = crossWindowTargetFor(source, point, this.windows(), this.topHeight, source.tabs.record(this.tabId)?.pinned === true)
    if (target === null) {
      this.clearMark()
    } else if (target.window !== this.markedWindow) {
      void refreshStripLayout(target.window) // its tabs may have moved since the drag began
      this.clearMark() // a different window than the one last marked, if any
      this.markedWindow = target.window
      this.markedIndex = target.index
      target.window.chrome.webContents.send(SHELL_EVENT_CHANNEL, { type: 'dragMark', index: target.index })
    } else if (target.index !== this.markedIndex) {
      // Same window, a different place in its strip: no clear/resend cycle, just the new index.
      this.markedIndex = target.index
      target.window.chrome.webContents.send(SHELL_EVENT_CHANNEL, { type: 'dragMark', index: target.index })
    }

    if (target !== null && stripCentresFor(target.window) === null && Date.now() >= this.nextRead) {
      this.nextRead = Date.now() + STRIP_READ_RETRY_MS
      void refreshStripLayout(target.window) // a tab opened or closed there since it was read
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
    if (this.mode === 'chip' || this.thumbnail === null) {
      // No thumbnail yet: either it has not resolved, or the capture came back empty outright --
      // typically a backgrounded tab's now-detached view, nothing left to draw. Either way the title
      // chip reads as a dragged tab; an empty window the pointer seems to have lost does not.
      void this.view.webContents.loadURL(`data:text/html,${encodeURIComponent(chipHtml(this.title, nativeTheme.shouldUseDarkColors))}`)
    } else {
      void this.view.webContents.loadURL(`data:text/html,${encodeURIComponent(thumbnailHtml(this.thumbnail, this.size.width, this.size.height))}`)
    }
  }
}

function imageToDataUrl (image: NativeImage | null, size: { width: number, height: number }): string | null {
  // Empty, not just absent, is also "nothing to draw": a detached view (a background tab, caught
  // before beginTabDrag's own activateTab call takes effect, or a tab that never painted) captures
  // to a zero-sized image rather than throwing -- render()'s own chip fallback is for both.
  if (image === null || image.isEmpty()) return null
  try {
    return image.resize(size).toDataURL()
  } catch {
    return null
  }
}
