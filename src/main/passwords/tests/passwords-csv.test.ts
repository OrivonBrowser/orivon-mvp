import { describe, expect, it } from 'vitest'
import { MAX_CSV_BYTES, MAX_CSV_ROWS, parseCsvRows, parsePasswordsCsv, printPasswordsCsv } from '../passwords-csv.js'
import { MAX_PASSWORD, MAX_USERNAME } from '../passwords-file.js'

describe('parseCsvRows', () => {
  it('splits cells and rows on commas and any line ending', () => {
    expect(parseCsvRows('a,b\r\nc,d\ne,f\rg,h')).toEqual([['a', 'b'], ['c', 'd'], ['e', 'f'], ['g', 'h']])
  })

  it('keeps commas, quotes and line breaks inside a quoted cell', () => {
    expect(parseCsvRows('"a,b","say ""hi""","line\r\nbreak"\n')).toEqual([['a,b', 'say "hi"', 'line\r\nbreak']])
  })

  it('keeps empty cells and skips empty lines and a byte order mark', () => {
    expect(parseCsvRows('﻿a,,c\n\n,,\n')).toEqual([['a', '', 'c'], ['', '', '']])
  })

  it('reads a last row with no line ending and an unterminated quote without failing', () => {
    expect(parseCsvRows('a,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']])
    expect(parseCsvRows('a,"open')).toEqual([['a', 'open']])
  })
})

describe('parsePasswordsCsv', () => {
  it('reads the header the other browsers export', () => {
    const parsed = parsePasswordsCsv('name,url,username,password,note\nShop,https://shop.example/login,ada,pw1,\n')
    expect(parsed).toEqual({ ok: true, logins: [{ origin: 'https://shop.example', username: 'ada', password: 'pw1' }], skipped: 0 })
  })

  it('reads a header that has no name column, in any order, in any case', () => {
    const parsed = parsePasswordsCsv('Password,"URL",Username\npw,http://127.0.0.1:8080/x,grace\n')
    expect(parsed).toEqual({ ok: true, logins: [{ origin: 'http://127.0.0.1:8080', username: 'grace', password: 'pw' }], skipped: 0 })
  })

  it('reads the password-manager header names', () => {
    const parsed = parsePasswordsCsv('folder,name,login_uri,login_username,login_password\n,x,https://a.example,u,p\n')
    expect(parsed).toMatchObject({ ok: true, logins: [{ origin: 'https://a.example', username: 'u', password: 'p' }] })
  })

  it('skips rows with no address, no password, or an address that is not http(s), and counts them', () => {
    const parsed = parsePasswordsCsv([
      'url,username,password',
      ',ada,pw',
      'https://ok.example,ada,',
      'android://hash@com.app,ada,pw',
      'javascript:alert(1),ada,pw',
      'file:///etc/passwd,ada,pw',
      'not a url,ada,pw',
      `https://long.example,${'u'.repeat(MAX_USERNAME + 1)},pw`,
      `https://long.example,ada,${'p'.repeat(MAX_PASSWORD + 1)}`,
      'https://ok.example,ada,fine'
    ].join('\n'))
    expect(parsed).toEqual({ ok: true, logins: [{ origin: 'https://ok.example', username: 'ada', password: 'fine' }], skipped: 8 })
  })

  it('allows a login with no username, and a file with no username column', () => {
    expect(parsePasswordsCsv('url,password\nhttps://a.example,p\n')).toMatchObject({ ok: true, logins: [{ username: '' }] })
  })

  it('refuses a file that is not a list of passwords', () => {
    expect(parsePasswordsCsv('a,b,c\n1,2,3\n')).toEqual({ ok: false, reason: 'not-passwords' })
    expect(parsePasswordsCsv('')).toEqual({ ok: false, reason: 'not-passwords' })
    expect(parsePasswordsCsv('url,username\nhttps://a.example,u\n')).toEqual({ ok: false, reason: 'not-passwords' })
  })

  it('refuses a file over the size cap and stops at the row cap', () => {
    expect(parsePasswordsCsv('x'.repeat(MAX_CSV_BYTES + 1))).toEqual({ ok: false, reason: 'too-large' })
    const rows = Array.from({ length: MAX_CSV_ROWS + 3 }, (_, index) => `https://a.example,u${String(index)},p`)
    const parsed = parsePasswordsCsv(`url,username,password\n${rows.join('\n')}`)
    expect(parsed).toMatchObject({ ok: true, skipped: 3 })
    expect(parsed.ok ? parsed.logins : []).toHaveLength(MAX_CSV_ROWS)
  })

  it('takes a cell as data: a formula or markup is just text', () => {
    const parsed = parsePasswordsCsv('url,username,password\nhttps://a.example,=cmd|x,<script>alert(1)</script>\n')
    expect(parsed).toMatchObject({ ok: true, logins: [{ username: '=cmd|x', password: '<script>alert(1)</script>' }] })
  })
})

describe('printPasswordsCsv', () => {
  it('prints the header and one row a login, quoting what needs it', () => {
    const text = printPasswordsCsv([
      { origin: 'https://shop.example', username: 'ada', password: 'plain' },
      { origin: 'http://127.0.0.1:8080', username: 'a,b', password: 'say "hi"\nthere' }
    ])
    expect(text).toBe('name,url,username,password,note\r\nshop.example,https://shop.example,ada,plain,\r\n127.0.0.1,http://127.0.0.1:8080,"a,b","say ""hi""\nthere",\r\n')
  })

  it('round-trips through the parser', () => {
    const logins = [
      { origin: 'https://shop.example', username: 'ada', password: 'p,w"\r\nx' },
      { origin: 'https://b.example:8443', username: '', password: 'é ü 漢' }
    ]
    expect(parsePasswordsCsv(printPasswordsCsv(logins))).toEqual({ ok: true, logins, skipped: 0 })
  })
})
