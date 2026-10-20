// The release description: the CHANGELOG section of the tag, the table of files, and the IPFS section, with
// whatever a person wrote above the generated part left alone on a re-run.
import { describe, expect, it } from 'vitest'
import {
  changelogSection,
  changesSection,
  composeNotes,
  ipfsSection,
  MARKER,
  shippedChanges,
  whichFileSection,
  withoutGenerated,
} from '../release-notes.mjs'

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- Not shipped yet.

## [0.0.7] - 2026-10-17

Pre-release, published 2026-10-17.

### Changed for apps

- **\`contracts/handles.ts\`**: a note for app authors.

### Added

- **A new thing**: it does a thing.
  A second line of the same item.

### Fixed

- **A fixed thing.**

### Security

## [0.0.6] - 2026-10-15

### Added

- Old.
`

const FILES = [
  'Orivon-Setup-0.0.7-x64.exe',
  'Orivon-0.0.7-arm64.dmg',
  'Orivon-0.0.7-x64.dmg',
  'Orivon-0.0.7-x86_64.AppImage',
  'orivon_0.0.7_amd64.deb',
  'ipfs.json',
]

const input = { changelog: CHANGELOG, tag: 'v0.0.7', repo: 'OrivonBrowser/orivon-mvp', assets: FILES, cid: 'bafyexample' }

describe('changelogSection', () => {
  it('takes the section of the version up to the next version heading', () => {
    const section = changelogSection(CHANGELOG, '0.0.7') ?? ''
    expect(section).toContain('A new thing')
    expect(section).not.toContain('Old.')
    expect(section).not.toContain('Not shipped yet')
  })

  it('does not take [Unreleased] for a version, nor 0.0.7 for 0.0.70', () => {
    expect(changelogSection(CHANGELOG, '0.0.70')).toBeNull()
    expect(changelogSection(CHANGELOG, '0.0.9')).toBeNull()
  })

  it('reads a changelog saved with CRLF line ends', () => {
    expect(changelogSection(CHANGELOG.replace(/\n/g, '\r\n'), '0.0.6')).toContain('Old.')
  })
})

describe('shippedChanges', () => {
  it('keeps Added and Fixed with their headings one level down, in the changelog order', () => {
    const text = shippedChanges(changelogSection(CHANGELOG, '0.0.7') ?? '')
    expect(text.indexOf('#### Added')).toBeLessThan(text.indexOf('#### Fixed'))
    expect(text).toContain('- **A new thing**: it does a thing.\n  A second line of the same item.')
  })

  it('leaves out the changes for app authors, the intro line and an empty heading', () => {
    const text = shippedChanges(changelogSection(CHANGELOG, '0.0.7') ?? '')
    expect(text).not.toContain('app authors')
    expect(text).not.toContain('published 2026')
    expect(text).not.toContain('Security')
  })
})

describe('changesSection', () => {
  it('links the changelog as it stands at the tag', () => {
    expect(changesSection({ changelog: CHANGELOG, version: '0.0.7', repo: 'a/b', tag: 'v0.0.7' })).toContain('(https://github.com/a/b/blob/v0.0.7/CHANGELOG.md)')
  })

  it('is null when the version has no section, or only changes for app authors', () => {
    expect(changesSection({ changelog: CHANGELOG, version: '0.0.9', repo: 'a/b', tag: 'v0.0.9' })).toBeNull()
    const onlyApps = '## [1.0.0] - x\n\n### Changed for apps\n\n- one\n'
    expect(changesSection({ changelog: onlyApps, version: '1.0.0', repo: 'a/b', tag: 'v1.0.0' })).toBeNull()
  })
})

describe('whichFileSection', () => {
  const base = { version: '0.0.7', assets: FILES, routes: {}, prerelease: true }

  it('has one row for each file the release carries, named exactly', () => {
    const table = whichFileSection(base) ?? ''
    for (const name of FILES.filter((f) => f !== 'ipfs.json')) expect(table).toContain(`\`${name}\``)
    expect(table).toContain('`ipfs.json` lists the SHA-256')
  })

  it('leaves out the row of a file the release does not carry', () => {
    const table = whichFileSection({ ...base, assets: ['Orivon-0.0.7-arm64.dmg'] }) ?? ''
    expect(table).toContain('Apple silicon')
    expect(table).not.toContain('Intel processor')
    expect(table).not.toContain('.deb')
    expect(table).not.toContain('Windows 10')
  })

  it('lists the Store, winget and the AUR only when the route is open', () => {
    const closed = whichFileSection(base) ?? ''
    expect(closed).not.toMatch(/Microsoft Store|winget|AUR/)
    const open = whichFileSection({ ...base, routes: { store: true, winget: true, aur: true } }) ?? ''
    expect(open).toContain('https://apps.microsoft.com/detail/9mxv3fnmfbp4')
    expect(open).toContain('winget install Orivon.Browser.Preview')
    expect(open).toContain('yay -S orivon-bin')
  })

  it('names the full release package for winget when the release is not a pre-release', () => {
    expect(whichFileSection({ ...base, routes: { winget: true }, prerelease: false })).toContain('winget install Orivon.Browser`')
  })

  it('escapes the pipe of the Terminal install, so the row stays three cells', () => {
    const row = (whichFileSection(base) ?? '').split('\n').find((line) => line.includes('curl')) ?? ''
    expect(row.replace(/\\\|/g, '').split('|')).toHaveLength(5)
  })

  it('is null when no known file is attached', () => {
    expect(whichFileSection({ ...base, assets: ['notes.txt'] })).toBeNull()
  })
})

describe('withoutGenerated', () => {
  it('cuts from the marker on, and keeps what is above it', () => {
    expect(withoutGenerated(`Hand-written.\n\n${MARKER}\n\n### What changed\n\nold`)).toBe('Hand-written.')
  })

  it('cuts a description from before the marker at its On IPFS heading, also with CRLF line ends', () => {
    expect(withoutGenerated('Hand-written.\r\n\r\n### On IPFS\r\n\r\nold text\r\n')).toBe('Hand-written.')
    expect(withoutGenerated('\n\n### On IPFS\n\nold text')).toBe('')
  })

  it('keeps a description that has neither', () => {
    expect(withoutGenerated('Only this.\n')).toBe('Only this.')
  })
})

describe('composeNotes', () => {
  it('writes the changes, the table and the IPFS section under the marker, in that order', () => {
    const { notes, warnings } = composeNotes(input)
    expect(warnings).toEqual([])
    expect(notes.startsWith(`${MARKER}\n\n### What changed`)).toBe(true)
    expect(notes.indexOf('### What changed')).toBeLessThan(notes.indexOf('### Which file is mine?'))
    expect(notes.indexOf('### Which file is mine?')).toBeLessThan(notes.indexOf('### On IPFS'))
    expect(notes).toContain('ipfs://bafyexample')
    expect(notes.endsWith('\n')).toBe(true)
  })

  it('keeps what a person wrote above the marker, and replaces the rest on a second run', () => {
    const first = composeNotes({ ...input, body: 'Highlights by hand.' }).notes
    const second = composeNotes({ ...input, body: first, cid: 'bafyother' }).notes
    expect(second.startsWith('Highlights by hand.\n\n' + MARKER)).toBe(true)
    expect(second.match(/### On IPFS/g)).toHaveLength(1)
    expect(second).toContain('ipfs://bafyother')
    expect(second).not.toContain('bafyexample')
    expect(composeNotes({ ...input, body: second }).notes.match(/### What changed/g)).toHaveLength(1)
  })

  it('converts a description the old workflow wrote, losing nothing above its IPFS section', () => {
    const { notes } = composeNotes({ ...input, body: 'Kept.\r\n\r\n### On IPFS\r\n\r\nThe same files, as one folder: `ipfs://old`.\r\n' })
    expect(notes.startsWith('Kept.\n\n' + MARKER)).toBe(true)
    expect(notes).not.toContain('ipfs://old')
  })

  it('names what it left out instead of failing', () => {
    const { notes, warnings } = composeNotes({ ...input, tag: 'v9.9.9', assets: [], cid: undefined })
    expect(warnings).toHaveLength(3)
    expect(notes).toBe(`${MARKER}\n`)
  })

  it('writes no date and does not call the release pre-alpha', () => {
    const { notes } = composeNotes({ ...input, routes: { store: true, winget: true, aur: true } })
    const generated = notes.slice(notes.indexOf('### Which file is mine?'))
    expect(generated).not.toMatch(/pre-alpha|\b20\d\d-\d\d-\d\d\b/i)
  })
})

describe('ipfsSection', () => {
  it('names the CID twice, as an address and as a command', () => {
    expect(ipfsSection('bafy')).toContain('`ipfs://bafy`')
    expect(ipfsSection('bafy')).toContain('`ipfs get bafy`')
  })
})
