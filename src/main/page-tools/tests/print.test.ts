import { describe, expect, it, vi } from 'vitest'
import { printPage } from '../print.js'
import type { PrintContents } from '../print.js'
import { fakeWindow } from './support.js'

function contents (printers: unknown[] | Error, extra: Partial<PrintContents> = {}): PrintContents & { print: ReturnType<typeof vi.fn> } {
  return {
    getPrintersAsync: async () => { if (printers instanceof Error) throw printers; return printers },
    print: vi.fn(),
    isCrashed: () => false,
    ...extra
  } as PrintContents & { print: ReturnType<typeof vi.fn> }
}

describe('printPage', () => {
  it('opens the system dialog with backgrounds on when a printer exists', async () => {
    const { window, toasts } = fakeWindow()
    const wc = contents([{ name: 'office' }])
    await printPage(window, wc)
    expect(wc.print).toHaveBeenCalledWith({ silent: false, printBackground: true }, expect.any(Function))
    expect(toasts()).toEqual([])
  })

  it('never calls print with no printer, and offers Save as PDF', async () => {
    const { window, toasts } = fakeWindow()
    const wc = contents([])
    await printPage(window, wc)
    expect(wc.print).not.toHaveBeenCalled()
    expect(toasts()).toEqual(['noPrinter'])
  })

  it('says so when the printers cannot be listed, and never prints', async () => {
    const { window, toasts } = fakeWindow()
    const wc = contents(new Error('cups'))
    vi.spyOn(console, 'error').mockImplementationOnce(() => {})
    await printPage(window, wc)
    expect(wc.print).not.toHaveBeenCalled()
    expect(toasts()).toEqual(['printFailed'])
  })

  it('does nothing to a crashed page but say so', async () => {
    const { window, toasts } = fakeWindow()
    const wc = contents([{}], { isCrashed: () => true })
    await printPage(window, wc)
    expect(wc.print).not.toHaveBeenCalled()
    expect(toasts()).toEqual(['printFailed'])
  })

  it('is silent when the person cancels and says so on any other failure', async () => {
    const { window, toasts } = fakeWindow()
    const wc = contents([{}])
    await printPage(window, wc)
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
    await printPage(window, wc)
    expect(toasts()).toEqual(['printFailed'])
  })
})
