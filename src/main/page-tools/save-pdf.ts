// Save as PDF: ask where, render the page to a PDF, and write it beside its final name first so a
// half-written file never has the name the person chose.
import { join } from 'node:path'
import type { PrintToPDFOptions } from 'electron'
import type { ShellWindow } from '../shell/window-registry.js'
import type { PageToolDeps } from './deps.js'
import { baseName, safeFileName } from './file-names.js'
import { showToast } from './toast.js'
import { withTimeout } from './with-timeout.js'

export interface PdfContents {
  printToPDF: (options: PrintToPDFOptions) => Promise<Uint8Array>
  isCrashed: () => boolean
}

const PDF_MS = 60_000

export async function savePdf (window: ShellWindow, page: { wc: PdfContents, title: string }, deps: PageToolDeps): Promise<void> {
  const path = await deps.pickSave(window.window, {
    title: 'Save as PDF',
    defaultPath: join(deps.downloadsDir(), safeFileName(page.title, 'pdf')),
    filters: [{ name: 'PDF document', extensions: ['pdf'] }]
  })
  if (path === undefined) return
  if (page.wc.isCrashed()) { showToast(window, 'pdfFailed'); return }
  showToast(window, 'savingPdf')
  const partial = `${path}.part`
  try {
    const pdf = await withTimeout(page.wc.printToPDF({ printBackground: true, preferCSSPageSize: true }), PDF_MS, 'the page')
    await deps.writeFile(partial, pdf)
    await deps.rename(partial, path)
    showToast(window, 'saved', baseName(path))
  } catch (error) {
    console.error('[page-tools] saving the PDF failed', error)
    await deps.remove(partial).catch(() => {})
    showToast(window, 'pdfFailed')
  }
}
