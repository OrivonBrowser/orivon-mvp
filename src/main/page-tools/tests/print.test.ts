import { describe, expect, it, vi } from 'vitest'
import { printPage } from '../print.js'
import type { PrintContents } from '../print.js'
import { fakeDeps, fakeWindow } from './support.js'

function contents (printers: unknown[] | Error, extra: Partial<PrintContents> = {}): PrintContents & { print: ReturnType<typeof vi.fn>, printToPDF: ReturnType<typeof vi.fn> } {
  return {
    printToPDF: vi.fn(async () => new Uint8Array([37, 80, 68, 70])),
    getPrintersAsync: async () => { if (printers instanceof Error) throw printers; return printers },
    print: vi.fn(),
    isCrashed: () => false,
    ...extra
  } as PrintContents & { print: ReturnType<typeof vi.fn>, printToPDF: ReturnType<typeof vi.fn> }
}

const page = (wc: PrintContents): { wc: PrintContents, title: string } => ({ wc, title: 'Article' })

describe('printPage', () => {
  it('opens the system dialog with backgrounds on when a printer exists', async () => {
    const { window, toasts } = fakeWindow()
    const wc = contents([{ name: 'office' }])
    await printPage(window, page(wc), fakeDeps())
    expect(wc.print).toHaveBeenCalledWith({ silent: false, printBackground: true }, expect.any(Function))
    expect(toasts()).toEqual([])
  })

  it('never calls print with no printer, and goes straight to Save as PDF', async () => {
    const { window, toasts } = fakeWindow()
    const wc = contents([])
    const deps = fakeDeps('/out/article.pdf')
    await printPage(window, page(wc), deps)
    expect(wc.print).not.toHaveBeenCalled()
    expect(deps.pickSave).toHaveBeenCalledWith(window.window, expect.objectContaining({ title: 'Save as PDF', defaultPath: '/home/me/Downloads/Article.pdf' }))
    expect(wc.printToPDF).toHaveBeenCalledTimes(1)
    expect(deps.files.get('/out/article.pdf')).toEqual(new Uint8Array([37, 80, 68, 70]))
    expect(toasts()).not.toContain('noPrinter')
  })

  it('writes nothing when the person closes the Save as PDF dialog on a machine with no printer', async () => {
    const { window } = fakeWindow()
    const wc = contents([])
    const deps = fakeDeps(null)
    await printPage(window, page(wc), deps)
    expect(wc.printToPDF).not.toHaveBeenCalled()
    expect(deps.files.size).toBe(0)
  })

  it('says so when the printers cannot be listed, and never prints', async () => {
    const { window, toasts } = fakeWindow()
    const wc = contents(new Error('cups'))
    vi.spyOn(console, 'error').mockImplementationOnce(() => {})
    await printPage(window, page(wc), fakeDeps())
    expect(wc.print).not.toHaveBeenCalled()
    expect(toasts()).toEqual(['printFailed'])
  })

  it('does nothing to a crashed page but say so', async () => {
    const { window, toasts } = fakeWindow()
    const wc = contents([{}], { isCrashed: () => true })
    await printPage(window, page(wc), fakeDeps())
    expect(wc.print).not.toHaveBeenCalled()
    expect(toasts()).toEqual(['printFailed'])
  })

  it('is silent when the person cancels and says so on any other failure', async () => {
    const { window, toasts } = fakeWindow()
    const wc = contents([{}])
    await printPage(window, page(wc), fakeDeps())
    const done = wc.print.mock.calls[0]?.[1] as (ok: boolean, reason: string) => void
    done(true, '')
    done(false, 'cancelled')
    expect(toasts()).toEqual([])
    done(false, 'failed')
    expect(toasts()).toEqual(['printFailed'])
  })

  it('reports a print call that throws', async () => {
    const { window, toasts } = fakeWindow()
    const wc = contents([{}])
    wc.print.mockImplementation(() => { throw new Error('boom') })
    vi.spyOn(console, 'error').mockImplementationOnce(() => {})
    await printPage(window, page(wc), fakeDeps())
    expect(toasts()).toEqual(['printFailed'])
  })
})
