import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NotificationDecisions, parseNotificationDecisions } from '../notification-decisions.js'

let dir: string
let path: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'orivon-notification-decisions-'))
  path = join(dir, 'notification-decisions.json')
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

describe('NotificationDecisions', () => {
  it('has no decision for an origin nobody was asked about, and creates no file for it', () => {
    const decisions = new NotificationDecisions(path)
    expect(decisions.get('https://example.com')).toBeUndefined()
    expect(readdirSync(dir)).toEqual([])
  })

  it('remembers allow and block across a restart', () => {
    const first = new NotificationDecisions(path)
    first.set('https://chat.example', 'allow')
    first.set('https://ads.example', 'block')

    const second = new NotificationDecisions(path)
    expect(second.get('https://chat.example')).toBe('allow')
    expect(second.get('https://ads.example')).toBe('block')
  })

  it('forgets one origin, on disk too, and leaves the others', () => {
    const first = new NotificationDecisions(path)
    first.set('https://chat.example', 'allow')
    first.set('https://ads.example', 'block')
    first.forget('https://ads.example')

    const second = new NotificationDecisions(path)
    expect(second.get('https://ads.example')).toBeUndefined()
    expect(second.entries()).toEqual([{ origin: 'https://chat.example', decision: 'allow' }])
  })

  it('leaves no temporary file behind after a write', () => {
    new NotificationDecisions(path).set('https://chat.example', 'allow')
    expect(readdirSync(dir)).toEqual(['notification-decisions.json'])
  })

  it('starts empty from a corrupt file rather than failing, and replaces it on the next answer', () => {
    writeFileSync(path, '{ not json')
    const decisions = new NotificationDecisions(path)
    expect(decisions.entries()).toEqual([])

    decisions.set('https://chat.example', 'allow')
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ version: 1, origins: { 'https://chat.example': 'allow' } })
  })

  // A failed write must not change what the person just answered for the
  // rest of this session: the answer is theirs, the disk is only a copy.
  it('keeps the answer in memory when the file cannot be written', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const decisions = new NotificationDecisions(join(dir, 'missing-parent', 'nested', '\0bad'))
    decisions.set('https://chat.example', 'allow')
    expect(decisions.get('https://chat.example')).toBe('allow')
    expect(console.error).toHaveBeenCalled()
  })
})

// The file is user-writable, so everything in it is untrusted input to the
// permission gate: an entry is kept only when its key is exactly the origin
// the gate would derive and its value is one of the two answers.
describe('parseNotificationDecisions', () => {
  it('keeps well-formed entries', () => {
    const parsed = parseNotificationDecisions(JSON.stringify({ version: 1, origins: { 'https://a.example': 'allow', 'http://127.0.0.1:8080': 'block' } }))
    expect([...parsed]).toEqual([['https://a.example', 'allow'], ['http://127.0.0.1:8080', 'block']])
  })

  it('drops keys that are not an origin in canonical form, and values that are not an answer', () => {
    const parsed = parseNotificationDecisions(JSON.stringify({
      version: 1,
      origins: {
        'https://a.example/': 'allow',
        'HTTPS://B.EXAMPLE': 'allow',
        'https://c.example:443': 'allow',
        'file:///etc/passwd': 'allow',
        'not a url': 'allow',
        'https://d.example': 'ask',
        'https://e.example': true,
        'https://f.example': 'block'
      }
    }))
    expect([...parsed]).toEqual([['https://f.example', 'block']])
  })

  it('reads nothing from a file of another version or shape', () => {
    for (const raw of ['[]', 'null', '"allow"', JSON.stringify({ version: 2, origins: { 'https://a.example': 'allow' } }), JSON.stringify({ version: 1, origins: [] })]) {
      expect(parseNotificationDecisions(raw).size).toBe(0)
    }
  })
})
