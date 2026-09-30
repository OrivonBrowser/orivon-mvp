import { describe, expect, it, vi } from 'vitest'
import { isToastCode, showToast, toastAction, toastView, TOAST_TEXT } from '../toast.js'
import { fakeWindow } from './support.js'

describe('toastView', () => {
  it('carries a fixed text and tone, and a file name beside it, never inside it', () => {
    expect(toastView('saved', 'report.pdf')).toEqual({ text: 'Saved', name: 'report.pdf', tone: 'ok', sticky: false })
    expect(toastView('pdfFailed')).toEqual({ text: 'Could not save the PDF', tone: 'error', sticky: false })
  })

  it('keeps only the message for work still going on', () => {
    expect(toastView('savingPdf').sticky).toBe(true)
    expect(Object.entries(TOAST_TEXT).filter(([, entry]) => 'sticky' in entry).map(([code]) => code)).toEqual(['savingPdf'])
  })

  it('offers Save as PDF from the no-printer message and from no other', () => {
    expect(toastView('noPrinter')).toMatchObject({ action: 'Save as PDF' })
    expect(toastAction('noPrinter')).toBe('page.pdf')
    expect(toastAction('saved')).toBeUndefined()
  })
})

describe('isToastCode', () => {
  it('accepts only a code the table has', () => {
    expect(isToastCode('saved')).toBe(true)
    expect(isToastCode('toString')).toBe(false)
    expect(isToastCode(3)).toBe(false)
  })
})

describe('showToast', () => {
  it('asks the window\'s toast overlay to show the code and the name', () => {
    const { window, show } = fakeWindow()
    showToast(window, 'saved', 'a.png')
    expect(show).toHaveBeenCalledWith('toast', undefined, { code: 'saved', name: 'a.png' })
  })

  it('never throws, whatever the overlay does', () => {
    const { window } = fakeWindow()
    window.overlays.show = vi.fn(() => { throw new Error('gone') })
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => { showToast(window, 'saved') }).not.toThrow()
    error.mockRestore()
  })
})
