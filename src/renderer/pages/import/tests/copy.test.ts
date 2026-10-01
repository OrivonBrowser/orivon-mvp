import { describe, expect, it } from 'vitest'
import type { ImportResult } from '../../../../main/import/import-types.js'
import { details, errorText, headline, progressText } from '../copy.js'

const result = (over: Partial<ImportResult> = {}): ImportResult => ({ bookmarks: 0, pages: 0, skipped: 0, known: 0, target: 'bar', ...over })

describe('headline', () => {
  it('states the numbers with thousands separators', () => {
    expect(headline(result({ bookmarks: 1204, pages: 8530 }), 'Chrome')).toBe('Imported 1,204 bookmarks and 8,530 pages of history from Chrome.')
  })

  it('uses the singular for one', () => {
    expect(headline(result({ bookmarks: 1, pages: 1 }), 'Firefox')).toBe('Imported 1 bookmark and 1 page of history from Firefox.')
  })

  it('names what was imported when it was only one kind', () => {
    expect(headline(result({ bookmarks: 3 }), 'Edge')).toBe('Imported 3 bookmarks from Edge.')
    expect(headline(result({ pages: 9 }), 'Brave')).toBe('Imported 9 pages of history from Brave.')
  })

  it('says so when there was nothing new, and when everything was already there', () => {
    expect(headline(result(), 'Chrome')).toBe('Nothing new was found in Chrome.')
    expect(headline(result({ known: 4 }), 'Chrome')).toBe('Everything in Chrome was already in Orivon.')
  })

  it('names a file as the file', () => {
    expect(headline(result({ bookmarks: 2 }), null)).toBe('Imported 2 bookmarks from the file.')
  })
})

describe('details', () => {
  it('says where the bookmarks are: on the bar, or in the named folder', () => {
    expect(details(result({ bookmarks: 2 }))).toEqual(['Your bookmarks bar now shows them.'])
    expect(details(result({ bookmarks: 2, target: 'folder', folderTitle: 'Imported from Chrome' }))).toEqual(['Bookmarks are in the folder "Imported from Chrome" on your bookmarks bar.'])
  })

  it('counts what was skipped and what was already there', () => {
    expect(details(result({ skipped: 37 }))).toEqual(['37 bookmarks were skipped because their addresses cannot be opened in Orivon.'])
    expect(details(result({ skipped: 1, known: 1 }))).toEqual(['1 bookmark was already in Orivon.', '1 bookmark was skipped because its address cannot be opened in Orivon.'])
  })

  it('says nothing about bookmarks when none came in', () => {
    expect(details(result({ pages: 5 }))).toEqual([])
  })
})

describe('errorText', () => {
  it('words each reason as the page shows it', () => {
    expect(errorText('locked', 'Chrome')).toBe('Orivon could not read Chrome\'s history while it is running. Close Chrome and try again.')
    expect(errorText('unreadable', 'Chrome')).toBe('This profile could not be read.')
    expect(errorText('format', null)).toBe('This file is not a bookmarks file.')
    expect(errorText('busy', null)).toBe('Another import is running. Wait for it to finish, then try again.')
    expect(errorText('private', null)).toBe('Importing is not available in a private window.')
    expect(errorText('unreadable', null)).toBe('This file could not be read.')
  })
})

describe('progressText', () => {
  it('follows the phase', () => {
    expect(progressText('bookmarks')).toBe('Importing bookmarks…')
    expect(progressText('history')).toBe('Importing history…')
    expect(progressText(null)).toBe('Importing bookmarks…')
  })
})
