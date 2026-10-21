import { describe, expect, it } from 'vitest'
import { changelogSection, releaseNotes } from '../release-notes.js'

const CHANGELOG = `# Changelog

## [Unreleased]

### Added

- **Not yet**: lands later.

## [0.2.0] - 2026-10-20

Pre-release text that is no bullet.

### Changed for apps

- **\`contracts/handles.ts\`**: for app authors only.

### Added

- **Look for updates**: asks once a day.
- **Secure DNS**: a long line that
  wraps onto a second one.

### Fixed

- Tabs no longer jump.

### Security

## [0.1.0] - 2026-10-01

### Added

- **Older**: shipped before.
`

describe('the notes of a version', () => {
  it('lists the shipped subsections and joins a wrapped bullet', () => {
    expect(releaseNotes(CHANGELOG, '0.2.0')).toEqual({
      version: '0.2.0',
      sections: [
        { heading: 'Added', items: ['**Look for updates**: asks once a day.', '**Secure DNS**: a long line that wraps onto a second one.'] },
        { heading: 'Fixed', items: ['Tabs no longer jump.'] }
      ]
    })
  })

  it('leaves out the heading for app authors and an empty subsection', () => {
    const notes = releaseNotes(CHANGELOG, '0.2.0')
    expect(notes?.sections.map((section) => section.heading)).toEqual(['Added', 'Fixed'])
  })

  it('stops at the next version and does not read [Unreleased] as a version', () => {
    expect(releaseNotes(CHANGELOG, '0.1.0')?.sections).toEqual([{ heading: 'Added', items: ['**Older**: shipped before.'] }])
    expect(releaseNotes(CHANGELOG, '0.0.0')).toBeNull()
  })

  it('is null for a version with no section, a section with nothing shipped, and 0.2 against 0.2.0', () => {
    expect(releaseNotes(CHANGELOG, '9.9.9')).toBeNull()
    expect(releaseNotes('## [1.0.0]\n\n### Changed for apps\n\n- x\n', '1.0.0')).toBeNull()
    expect(changelogSection(CHANGELOG, '0.2')).toBeNull()
  })

  it('reads CRLF files', () => {
    expect(releaseNotes(CHANGELOG.replace(/\n/g, '\r\n'), '0.1.0')?.sections).toHaveLength(1)
  })
})
