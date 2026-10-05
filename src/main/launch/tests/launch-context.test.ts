import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { PROFILE_ID, flagsFor, parseLaunch, switchesOf, urlsFromArgv, withoutAddresses } from '../launch-context.js'

const HOME = '/home/person/.config/orivon'
const parse = (...argv: string[]): ReturnType<typeof parseLaunch> => parseLaunch(['/usr/bin/orivon', '--no-sandbox', ...argv], HOME)

describe('parseLaunch', () => {
  it('is the default profile in the browser\'s own directory when nothing is named', () => {
    expect(parse()).toEqual({ ok: true, launch: { kind: 'default', home: HOME, dir: HOME } })
    expect(parse('--orivon-profile=default')).toEqual({ ok: true, launch: { kind: 'default', home: HOME, dir: HOME } })
  })

  it('is another profile in a directory of its own inside it', () => {
    expect(parse('--orivon-profile=a1b2c3d4e5f6')).toEqual({ ok: true, launch: { kind: 'profile', id: 'a1b2c3d4e5f6', home: HOME, dir: join(HOME, 'profiles', 'a1b2c3d4e5f6') } })
  })

  it('is a private session, with the directory it was made if it was made one', () => {
    expect(parse('--orivon-private')).toEqual({ ok: true, launch: { kind: 'private', home: HOME, dir: null } })
    expect(parse('--orivon-private', '--orivon-private-dir=/tmp/orivon-private-Ab3dEf')).toEqual({ ok: true, launch: { kind: 'private', home: HOME, dir: '/tmp/orivon-private-Ab3dEf' } })
    expect(parse('--orivon-private', '--orivon-private-dir=')).toEqual({ ok: true, launch: { kind: 'private', home: HOME, dir: null } })
  })

  it('refuses an id that could not have been made here, so no path is ever built from one', () => {
    for (const bad of ['../evil', '..', 'a/b', 'A1B2C3D4E5F6', 'short', 'x'.repeat(40), '', 'a1b2c3d4e5f6/../..', 'a1b2c3d4e5f\u0000']) {
      const result = parse(`--orivon-profile=${bad}`)
      expect(result.ok, bad).toBe(false)
    }
  })

  it('refuses a launch that asks to be two things', () => {
    expect(parse('--orivon-private', '--orivon-profile=a1b2c3d4e5f6').ok).toBe(false)
    expect(parse('--orivon-profile=a1b2c3d4e5f6', '--orivon-profile=b1b2c3d4e5f6').ok).toBe(false)
  })
})

describe('a launch that has a link after the end of the switches', () => {
  it('is not changed by anything that link carries', () => {
    expect(parseLaunch(['/opt/Orivon/orivon', '--', '--orivon-private'], HOME)).toEqual({ ok: true, launch: { kind: 'default', home: HOME, dir: HOME } })
    expect(parseLaunch(['/opt/Orivon/orivon', '--', '--orivon-profile=../evil'], HOME)).toEqual({ ok: true, launch: { kind: 'default', home: HOME, dir: HOME } })
    expect(parseLaunch(['/opt/Orivon/orivon', '--orivon-private', '--', '--orivon-private-dir=/etc'], HOME)).toEqual({ ok: true, launch: { kind: 'private', home: HOME, dir: null } })
  })
})

describe('switchesOf', () => {
  it('is the command line up to the first `--`, and the whole of it when there is none', () => {
    expect(switchesOf(['a', '--no-sandbox', '--', '--user-data-dir=/x', '--'])).toEqual(['a', '--no-sandbox'])
    expect(switchesOf(['a', '--no-sandbox'])).toEqual(['a', '--no-sandbox'])
  })
})

describe('the shape of a profile id', () => {
  it('is what randomBytes(6).toString("hex") makes, and nothing that names a path', () => {
    expect(PROFILE_ID.test('0123456789ab')).toBe(true)
    expect(PROFILE_ID.test('.hidden00')).toBe(false)
    expect(PROFILE_ID.test('0123456789abc')).toBe(false)
    expect(PROFILE_ID.test('0123456789ag')).toBe(false)
    expect(PROFILE_ID.test('01234567')).toBe(false)
    expect(PROFILE_ID.test('has space1')).toBe(false)
  })
})

describe('flagsFor', () => {
  it('is what parseLaunch reads back', () => {
    const profile = flagsFor({ kind: 'profile', id: 'a1b2c3d4e5f6' })
    expect(parseLaunch(['x', ...profile], HOME)).toMatchObject({ ok: true, launch: { kind: 'profile', id: 'a1b2c3d4e5f6' } })
    const session = flagsFor({ kind: 'private', dir: '/tmp/orivon-private-Ab3dEf' })
    expect(parseLaunch(['x', ...session], HOME)).toEqual({ ok: true, launch: { kind: 'private', home: HOME, dir: '/tmp/orivon-private-Ab3dEf' } })
  })
})

describe('urlsFromArgv', () => {
  it('keeps the web addresses on a command line, whole, and nothing else', () => {
    expect(urlsFromArgv(['/usr/bin/orivon', '--no-sandbox', 'https://example.com/a?b=c', 'HTTP://EXAMPLE.org', 'file:///etc/passwd', 'javascript:alert(1)', 'orivon://settings', 'notes.txt', '--flag=https://x.example']))
      .toEqual(['https://example.com/a?b=c', 'http://example.org/'])
  })

  it('takes no more than the limit, and skips what does not parse', () => {
    const many = Array.from({ length: 20 }, (_, n) => `https://s${String(n)}.example/`)
    expect(urlsFromArgv(many)).toHaveLength(8)
    expect(urlsFromArgv(many, 3)).toHaveLength(3)
    expect(urlsFromArgv(['https://', 'http://[bad'])).toEqual([])
  })
})

describe('withoutAddresses', () => {
  it('drops the addresses and the launcher actions, so a restart opens none of them a second time, and keeps the rest', () => {
    expect(withoutAddresses(['/usr/bin/orivon', '--new-window', '--new-private-window', '--no-sandbox', 'https://a.example/']))
      .toEqual(['/usr/bin/orivon', '--no-sandbox'])
  })
})
