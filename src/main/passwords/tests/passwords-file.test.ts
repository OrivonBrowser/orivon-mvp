import { describe, expect, it } from 'vitest'
import { FILE_VERSION, isStorableOrigin, loginKey, MAX_LOGINS, parsePasswordsFile, printPasswordsFile } from '../passwords-file.js'
import type { StoredLogin } from '../passwords-file.js'

const login = (overrides: Partial<StoredLogin> = {}): StoredLogin => ({ id: 'a', origin: 'https://a.example', username: 'ada', secret: 'QUJD', created: 1, used: 0, ...overrides })

describe('isStorableOrigin', () => {
  it('takes an http(s) origin in its canonical shape, and nothing else', () => {
    for (const origin of ['https://a.example', 'http://127.0.0.1:8080', 'https://a.example:8443']) expect(isStorableOrigin(origin), origin).toBe(true)
    for (const origin of ['https://a.example/', 'https://a.example/path', 'HTTPS://A.EXAMPLE', 'ftp://a.example', 'file:///x', 'orivon://settings', 'a.example', '', 7, null]) expect(isStorableOrigin(origin), String(origin)).toBe(false)
  })
})

describe('parsePasswordsFile', () => {
  it('round-trips what it prints', () => {
    const text = printPasswordsFile([login(), login({ id: 'b', username: 'grace' })], ['https://never.example'])
    expect(parsePasswordsFile(text)).toEqual({ status: 'ok', logins: [login(), login({ id: 'b', username: 'grace' })], never: ['https://never.example'], dropped: 0 })
    expect(JSON.parse(text).version).toBe(FILE_VERSION)
  })

  it('calls a file that is not the expected shape corrupt', () => {
    for (const text of ['', 'nope', '[]', '7', 'null', '{"version":1}', '{"version":2,"logins":[]}', '{"logins":[]}']) expect(parsePasswordsFile(text).status, text).toBe('corrupt')
  })

  it('drops an entry that is not valid and says how many', () => {
    const bad = [{ ...login({ id: 'c' }), origin: 'https://a.example/x' }, { ...login({ id: 'd' }), secret: '' }, { ...login({ id: 'e' }), created: -1 }, { ...login({ id: 'f' }), used: 'soon' }, { ...login({ id: '' }) }, null, 'x']
    const parsed = parsePasswordsFile(JSON.stringify({ version: 1, logins: [login(), ...bad], never: ['bad', 'https://n.example', 'https://n.example'] }))
    expect(parsed).toMatchObject({ status: 'ok', dropped: bad.length + 2 })
    expect(parsed.status === 'ok' ? parsed.logins.map((entry) => entry.id) : []).toEqual(['a'])
  })

  it('drops a repeated id, a repeated login, and any past the cap', () => {
    const many = Array.from({ length: MAX_LOGINS + 5 }, (_, index) => login({ id: `id${String(index)}`, username: `u${String(index)}` }))
    const parsed = parsePasswordsFile(JSON.stringify({ version: 1, logins: [login(), login(), login({ id: 'z' }), ...many], never: [] }))
    expect(parsed.status === 'ok' ? parsed.logins.length : 0).toBe(MAX_LOGINS)
    expect(parsed.status === 'ok' ? parsed.dropped : 0).toBe(2 + 5 + 1)
  })

  it('tells a login by its origin and username together', () => {
    expect(loginKey('https://a.example', 'ada')).not.toBe(loginKey('https://a.example', 'ada '))
    expect(loginKey('https://a.example', 'b')).not.toBe(loginKey('https://a.exampl', 'eb'))
  })
})
