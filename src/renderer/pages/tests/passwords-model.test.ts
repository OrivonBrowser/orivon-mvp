import { describe, expect, it } from 'vitest'
import { filterLogins, hostOf, markColor, markLetter, marksFor, SHOWN_LIMIT, sortLogins, transferNotice, visibleEntries } from '../settings/passwords/passwords-model.js'
import type { LoginRow } from '../settings/passwords/passwords-model.js'

const login = (origin: string, username: string, id = `${origin}|${username}`): LoginRow => ({ id, origin, username, created: 1, used: 0 })

describe('hostOf', () => {
  it('drops https:// and keeps a plain http site visibly plain', () => {
    expect(hostOf('https://shop.example')).toBe('shop.example')
    expect(hostOf('https://shop.example:8443')).toBe('shop.example:8443')
    expect(hostOf('http://127.0.0.1:8080')).toBe('http://127.0.0.1:8080')
  })
})

describe('sortLogins', () => {
  it('orders by site, then username, ignoring case and reading numbers as numbers', () => {
    const sorted = sortLogins([login('https://b.example', 'ada'), login('https://A.example', 'zed'), login('https://a.example', 'Ben'), login('https://a.example', 'amy'), login('https://c2.example', 'x'), login('https://c10.example', 'x')])
    expect(sorted.map((entry) => `${hostOf(entry.origin)} ${entry.username}`)).toEqual(['a.example amy', 'a.example Ben', 'A.example zed', 'b.example ada', 'c2.example x', 'c10.example x'])
  })

  it('leaves the list it was given alone', () => {
    const list = [login('https://b.example', 'a'), login('https://a.example', 'a')]
    sortLogins(list)
    expect(list[0]?.origin).toBe('https://b.example')
  })
})

describe('marksFor', () => {
  it('finds every occurrence, ignoring case', () => {
    expect(marksFor('Shop.shop.example', ['shop'])).toEqual([{ start: 0, end: 4 }, { start: 5, end: 9 }])
  })

  it('merges marks that touch or overlap, and finds nothing for no words', () => {
    expect(marksFor('abcdef', ['abc', 'cde', 'ef'])).toEqual([{ start: 0, end: 6 }])
    expect(marksFor('abcdef', [])).toEqual([])
    expect(marksFor('abcdef', ['xyz'])).toEqual([])
  })
})

describe('filterLogins', () => {
  const logins = [login('https://shop.example', 'ada'), login('https://mail.example', 'ada.lovelace'), login('https://shop.example', 'grace'), login('http://127.0.0.1:8080', '')]

  it('keeps everything for an empty or blank query, with no marks', () => {
    for (const query of ['', '   ']) {
      const entries = filterLogins(logins, query)
      expect(entries).toHaveLength(4)
      expect(entries.every((entry) => entry.hostMarks.length === 0 && entry.userMarks.length === 0)).toBe(true)
    }
  })

  it('matches the site or the username, ignoring case, and marks where', () => {
    const entries = filterLogins(logins, 'ADA')
    expect(entries.map((entry) => entry.login.origin + '|' + entry.login.username)).toEqual(['https://shop.example|ada', 'https://mail.example|ada.lovelace'])
    expect(entries[0]?.userMarks).toEqual([{ start: 0, end: 3 }])
    expect(entries[0]?.hostMarks).toEqual([])
    expect(filterLogins(logins, 'mail')[0]?.hostMarks).toEqual([{ start: 0, end: 4 }])
  })

  it('needs every word, each in the site or the username', () => {
    expect(filterLogins(logins, 'shop grace').map((entry) => entry.login.username)).toEqual(['grace'])
    expect(filterLogins(logins, 'mail grace')).toEqual([])
  })

  it('matches a site that is shown with its scheme', () => {
    expect(filterLogins(logins, 'http://127').map((entry) => entry.host)).toEqual(['http://127.0.0.1:8080'])
  })
})

describe('visibleEntries', () => {
  const many = Array.from({ length: SHOWN_LIMIT + 7 }, (_, index) => index)

  it('shows the first rows and counts the rest', () => {
    expect(visibleEntries(many, false)).toEqual({ shown: many.slice(0, SHOWN_LIMIT), hidden: 7 })
  })

  it('shows all of them when asked, and when they fit', () => {
    expect(visibleEntries(many, true)).toEqual({ shown: many, hidden: 0 })
    expect(visibleEntries(many.slice(0, SHOWN_LIMIT), false).hidden).toBe(0)
  })
})

describe('transferNotice', () => {
  it('says nothing after a cancel', () => {
    expect(transferNotice({ kind: 'cancelled' })).toBeNull()
  })

  it('reports an import in the plural and the singular', () => {
    expect(transferNotice({ kind: 'imported', added: 42, updated: 0, unchanged: 0, skipped: 3 })).toEqual({ tone: 'ok', text: 'Imported 42 passwords. 3 rows were skipped.' })
    expect(transferNotice({ kind: 'imported', added: 1, updated: 0, unchanged: 0, skipped: 1 })?.text).toBe('Imported 1 password. 1 row was skipped.')
  })

  it('counts the updated ones and the ones already saved', () => {
    expect(transferNotice({ kind: 'imported', added: 3, updated: 2, unchanged: 4, skipped: 0 })?.text).toBe('Imported 5 passwords, 2 of them updated. 4 were already saved.')
    expect(transferNotice({ kind: 'imported', added: 0, updated: 0, unchanged: 1, skipped: 0 })?.text).toBe('Imported 0 passwords. 1 was already saved.')
  })

  it('warns that an export is a file anyone can read', () => {
    expect(transferNotice({ kind: 'exported', count: 42 })).toEqual({ tone: 'warn', text: 'Exported 42 passwords to a file anyone can read. Delete it when you are done.' })
  })

  it('explains a failure in words, and has words for one it does not know', () => {
    for (const reason of ['unavailable', 'too-large', 'unreadable', 'not-passwords', 'not-written']) expect(transferNotice({ kind: 'failed', reason })).toMatchObject({ tone: 'error', text: expect.stringMatching(/\.$/) })
    expect(transferNotice({ kind: 'failed', reason: 'other' })?.text).toBe('That did not work.')
  })
})

describe('the site mark', () => {
  it('is the first letter of the name, without www', () => {
    expect(markLetter('www.shop.example')).toBe('S')
    expect(markLetter('http://127.0.0.1:8080')).toBe('1')
    expect(markLetter('')).toBe('?')
  })

  it('is the same colour for a site every time, and one of the named ones', () => {
    expect(markColor('shop.example')).toBe(markColor('www.shop.example'))
    expect(['blue', 'green', 'orange', 'red', 'purple', 'pink', 'teal', 'gray']).toContain(markColor('anything'))
  })
})
