// The few-second notice a window shows when a page takes the screen or the
// pointer: "Press Esc to exit full screen", "Press Esc to show your cursor".
// A page that fills the screen can draw a fake address bar, and one that
// hides the pointer can leave the person unsure how to get it back, so the
// shell says how; Chrome, Firefox and Safari show the same notices. One per
// window, like Chrome's one bubble: a newer message replaces the old.
import { WebContentsView, type BaseWindow, type View } from 'electron'

const NOTICE_WIDTH = 320
const NOTICE_HEIGHT = 44
const NOTICE_TOP = 24
const NOTICE_MS = 4_000

/** Every message a notice can carry. Markup the shell wrote, never page text. */
export const NOTICES = {
  fullscreen: 'Press <b>Esc</b> to exit full screen',
  // The page holds Escape through the Keyboard Lock API, so one press goes
  // to the page; holding it is what the browser process still acts on.
  holdEscToExitFullscreen: 'Press and hold <b>Esc</b> to exit full screen',
  pointerLock: 'Press <b>Esc</b> to show your cursor'
} as const

export type NoticeText = typeof NOTICES[keyof typeof NOTICES]

function noticeUrl (text: NoticeText): string {
  const html = '<!doctype html><meta charset="utf-8"><body style="margin:0;height:100vh;display:flex;' +
    'align-items:center;justify-content:center;border-radius:8px;background:rgba(32,33,36,.92);' +
    `color:#fff;font:14px system-ui,sans-serif"><span>${text}</span></body>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}

export interface WindowNotice {
  show: (text: NoticeText) => void
  hide: () => void
  /** Re-centres a visible notice after the window's width changed. */
  layout: () => void
  dispose: () => void
}

export function createWindowNotice (contentView: View, windowWidth: () => number): WindowNotice {
  let view: WebContentsView | undefined
  let loaded: NoticeText | undefined
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

  function show (text: NoticeText): void {
    if (view === undefined) {
      view = new WebContentsView({ webPreferences: { javascript: false, sandbox: true, contextIsolation: true, nodeIntegration: false } })
      view.setBackgroundColor('#00000000')
    }
    if (loaded !== text) {
      loaded = text
      void view.webContents.loadURL(noticeUrl(text))
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
    loaded = undefined
  }

  return { show, hide, layout, dispose }
}

const notices = new WeakMap<BaseWindow, WindowNotice>()

/** The window's one notice, created on first use and disposed with the window. */
export function noticeForWindow (win: BaseWindow): WindowNotice {
  const existing = notices.get(win)
  if (existing !== undefined) return existing
  const notice = createWindowNotice(win.contentView, () => win.getContentBounds().width)
  notices.set(win, notice)
  // A macrotask, not synchronously: 'resize' reports the pre-resize bounds
  // under X11 (window.ts has the measurement).
  win.on('resize', () => { setImmediate(() => { notice.layout() }) })
  win.on('closed', () => {
    notices.delete(win)
    notice.dispose()
  })
  return notice
}
