import { describe, expect, it } from 'vitest'
import { describePickerDialog } from '../picker-dialog.js'

// `pickPath`'s real `dialog.showOpenDialog` call cannot be exercised from
// this suite (../picker-dialog.ts's own header: `dialog` is a real Electron
// value import, untouched by anything ipc.test.ts calls) -- `describePickerDialog`
// is the pure text-building half, split out so the owner-approved wording
// (d-0032) has a real regression test rather than living only in a comment.
//
// `origin` is ALWAYS present (T3: derived from the sender's frame, never
// omittable the way `appName` is) and always appears in `title` -- the
// original wording named no origin at all, so a page could pop a picker
// under a friendly, self-declared `appName` with nothing to say which
// site actually asked.

const ORIGIN = 'https://torrent.example'

describe('describePickerDialog -- the folder shape (d-0032, owner-approved verbatim)', () => {
  it('names the app AND the origin in the title, and carries the full message including the load-bearing phrase', () => {
    const result = describePickerDialog({ directory: true, multiple: false, appName: 'Torrent App', origin: ORIGIN })
    expect(result.title).toBe(`Choose a folder for "Torrent App" (${ORIGIN}) -- it can read, change and delete everything in this folder, including files you add to it later`)
    expect(result.buttonLabel).toBe('Allow access to this folder')
    expect(result.message).toBe(
      `This app will be able to read, change and delete everything in this folder, including files you add to it later. Requested by "Torrent App" (${ORIGIN}).`
    )
  })

  it('the load-bearing phrase survives independent of the app name -- never trimmed', () => {
    const result = describePickerDialog({ directory: true, multiple: false, appName: undefined, origin: ORIGIN })
    expect(result.message).toContain('including files you add to it later')
  })

  it('names only the origin when no manifest was ever registered for it -- never a bare, nameless dialog', () => {
    const result = describePickerDialog({ directory: true, multiple: false, appName: undefined, origin: ORIGIN })
    expect(result.title).toBe(`Choose a folder for ${ORIGIN} -- it can read, change and delete everything in this folder, including files you add to it later`)
  })

  it('the delete warning appears in the title too, not only in the macOS-only message', () => {
    const result = describePickerDialog({ directory: true, multiple: false, appName: undefined, origin: ORIGIN })
    expect(result.title).toContain('delete')
  })
})

describe('describePickerDialog -- the file shapes (derived from d-0032\'s voice, not separately owner-reviewed)', () => {
  it('a single file: names what a FileHandle actually permits, no delete claim, the app AND the origin', () => {
    const result = describePickerDialog({ directory: false, multiple: false, appName: 'Torrent App', origin: ORIGIN })
    expect(result.title).toBe(`Choose a file for "Torrent App" (${ORIGIN}) -- it can read and change this file, including emptying it`)
    expect(result.buttonLabel).toBe('Allow access to this file')
    expect(result.message).toBe(`This app will be able to read and change this file, including emptying it. Requested by "Torrent App" (${ORIGIN}).`)
  })

  it('multiple files: same voice, plural', () => {
    const result = describePickerDialog({ directory: false, multiple: true, appName: 'Torrent App', origin: ORIGIN })
    expect(result.title).toBe(`Choose files for "Torrent App" (${ORIGIN}) -- it can read and change these files, including emptying them`)
    expect(result.buttonLabel).toBe('Allow access to these files')
    expect(result.message).toBe(`This app will be able to read and change these files, including emptying them. Requested by "Torrent App" (${ORIGIN}).`)
  })

  it('a nameless origin still gets a complete dialog, naming the origin in place of a quoted app name', () => {
    const result = describePickerDialog({ directory: false, multiple: false, appName: undefined, origin: ORIGIN })
    expect(result.title).toBe(`Choose a file for ${ORIGIN} -- it can read and change this file, including emptying it`)
    expect(result.buttonLabel).toBe('Allow access to this file')
  })
})
