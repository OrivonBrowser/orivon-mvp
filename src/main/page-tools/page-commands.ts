// The `page.*` commands, one function each over the window the command was pressed in.
import type { ShellWindow } from '../shell/window-registry.js'
import { activePage } from './active-page.js'
import type { PageToolDeps } from './deps.js'
import { printPage } from './print.js'
import { togglePictureInPicture } from './pip.js'
import { savePage } from './save-page.js'
import { savePdf } from './save-pdf.js'
import { showToast } from './toast.js'
import { openViewSource } from './view-source.js'

/** A command runs detached from the key that pressed it, so a failure ends here and never as an unhandled rejection. */
async function guarded (name: string, work: () => void | Promise<void>): Promise<void> {
  try {
    await work()
  } catch (error) {
    console.error(`[page-tools] ${name} failed`, error)
  }
}

export async function printCommand (target: ShellWindow): Promise<void> {
  await guarded('print', async () => {
    const page = activePage(target)
    if (page !== undefined) await printPage(target, page.wc)
  })
}

export async function pdfCommand (target: ShellWindow, deps: PageToolDeps): Promise<void> {
  await guarded('save as PDF', async () => {
    const page = activePage(target)
    if (page !== undefined) await savePdf(target, page, deps)
  })
}

export async function saveCommand (target: ShellWindow, deps: PageToolDeps): Promise<void> {
  await guarded('save page', async () => {
    const page = activePage(target)
    if (page !== undefined) await savePage(target, page, deps)
  })
}

export async function viewSourceCommand (target: ShellWindow): Promise<void> {
  await guarded('view source', () => {
    const page = activePage(target)
    if (page !== undefined && !openViewSource(target.tabs, page.url)) showToast(target, 'noSource')
  })
}

export async function screenshotCommand (target: ShellWindow): Promise<void> {
  await guarded('screenshot', () => {
    if (activePage(target) !== undefined) target.overlays.toggle('screenshot')
  })
}

export async function pipCommand (target: ShellWindow): Promise<void> {
  await guarded('picture in picture', async () => {
    const page = activePage(target)
    if (page === undefined) return
    if (await togglePictureInPicture(page.wc) === 'none') showToast(target, 'noVideo')
  })
}
