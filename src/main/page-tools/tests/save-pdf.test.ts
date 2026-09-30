import { describe, expect, it, vi } from 'vitest'
import { savePdf } from '../save-pdf.js'
import type { PdfContents } from '../save-pdf.js'
import { fakeDeps, fakeWindow } from './support.js'

const pdf = new Uint8Array([0x25, 0x50, 0x44, 0x46])
const page = (extra: Partial<PdfContents> = {}): { wc: PdfContents & { printToPDF: ReturnType<typeof vi.fn> }, title: string } =>
  ({ wc: { printToPDF: vi.fn(async () => pdf), isCrashed: () => false, ...extra } as PdfContents & { printToPDF: ReturnType<typeof vi.fn> }, title: 'My page: part 1' })

describe('savePdf', () => {
  it('asks where, starting in Downloads with a name from the title', async () => {
    const { window } = fakeWindow()
    const deps = fakeDeps()
    await savePdf(window, page(), deps)
    expect(deps.pickSave).toHaveBeenCalledWith(window.window, expect.objectContaining({ title: 'Save as PDF', defaultPath: '/home/me/Downloads/My page part 1.pdf' }))
  })

  it('writes the PDF under its chosen name and only then says so, with backgrounds on', async () => {
    const { window, toasts, show } = fakeWindow()
    const deps = fakeDeps('/out/report.pdf')
    const { wc, title } = page()
    await savePdf(window, { wc, title }, deps)
    expect(wc.printToPDF).toHaveBeenCalledWith({ printBackground: true, preferCSSPageSize: true })
    expect([...deps.files.keys()]).toEqual(['/out/report.pdf'])
    expect(deps.files.get('/out/report.pdf')).toEqual(pdf)
    expect(toasts()).toEqual(['savingPdf', 'saved'])
    expect(show).toHaveBeenLastCalledWith('toast', undefined, { code: 'saved', name: 'report.pdf', revealPath: '/out/report.pdf' })
  })

  it('writes nothing and shows nothing when the person cancels', async () => {
    const { window, toasts } = fakeWindow()
    const deps = fakeDeps(null)
    const { wc, title } = page()
    await savePdf(window, { wc, title }, deps)
    expect(wc.printToPDF).not.toHaveBeenCalled()
    expect(deps.files.size).toBe(0)
    expect(toasts()).toEqual([])
  })

  it('leaves no partial file behind when rendering fails, and says so', async () => {
    const { window, toasts } = fakeWindow()
    const deps = fakeDeps('/out/report.pdf')
    const { wc, title } = page({ printToPDF: async () => { throw new Error('render') } })
    vi.spyOn(console, 'error').mockImplementationOnce(() => {})
    await savePdf(window, { wc, title }, deps)
    expect(deps.files.size).toBe(0)
    expect(toasts()).toEqual(['savingPdf', 'pdfFailed'])
  })

  it('removes the partial file when the write fails half way', async () => {
    const { window, toasts } = fakeWindow()
    const deps = fakeDeps('/out/report.pdf')
    deps.writeFile = async (path) => { deps.files.set(path, new Uint8Array(1)); throw new Error('disk full') }
    const { wc, title } = page()
    vi.spyOn(console, 'error').mockImplementationOnce(() => {})
    await savePdf(window, { wc, title }, deps)
    expect(deps.files.size).toBe(0)
    expect(toasts()).toEqual(['savingPdf', 'pdfFailed'])
  })

  it('does not wait on a crashed page', async () => {
    const { window, toasts } = fakeWindow()
    const { wc, title } = page({ isCrashed: () => true })
    await savePdf(window, { wc, title }, fakeDeps())
    expect(wc.printToPDF).not.toHaveBeenCalled()
    expect(toasts()).toEqual(['pdfFailed'])
  })
})
