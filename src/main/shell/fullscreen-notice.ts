// "Press Esc to exit full screen", shown for a few seconds whenever a page
// takes the screen. A page filling the screen can draw a fake address bar,
// so the person has to be told the real one is gone and how to get it back;
// Chrome, Firefox and Safari all show the same notice for the same reason.
import { WebContentsView, type View } from 'electron'

const NOTICE_WIDTH = 320
const NOTICE_HEIGHT = 44
const NOTICE_TOP = 24
const NOTICE_MS = 4_000

const NOTICE_HTML = '<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:flex;' +
  'align-items:center;justify-content:center;border-radius:8px;background:rgba(32,33,36,.92);' +
  'color:#fff;font:14px system-ui,sans-serif">Press&nbsp;<b>Esc</b>&nbsp;to exit full screen</body>'

export interface FullscreenNotice {
  show: () => void
  hide: () => void
  /** Re-centres a visible notice after the window's width changed. */
  layout: () => void
  dispose: () => void
}

export function createFullscreenNotice (contentView: View, windowWidth: () => number): FullscreenNotice {
  let view: WebContentsView | undefined
  let shown = false
  let timer: ReturnType<typeof setTimeout> | undefined

  function layout (): void {
    if (view === undefined || !shown) return
    const x = Math.max(0, Math.round((windowWidth() - NOTICE_WIDTH) / 2))
    view.setBounds({ x, y: NOTICE_TOP, width: NOTICE_WIDTH, height: NOTICE_HEIGHT })
  }

  function hide (): void {
    clearTimeout(timer)
    if (view !== undefined && shown) contentView.removeChildView(view)
    shown = false
  }

  function show (): void {
    if (view === undefined) {
      view = new WebContentsView({ webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      view.setBackgroundColor('#00000000')
      void view.webContents.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(NOTICE_HTML)}`)
    }
    // Added last, so it sits above the tab view that just filled the window.
    if (!shown) contentView.addChildView(view)
    shown = true
    layout()
    clearTimeout(timer)
    timer = setTimeout(hide, NOTICE_MS)
  }

  function dispose (): void {
    hide()
    if (view !== undefined && !view.webContents.isDestroyed()) view.webContents.close()
    view = undefined
  }

  return { show, hide, layout, dispose }
}
