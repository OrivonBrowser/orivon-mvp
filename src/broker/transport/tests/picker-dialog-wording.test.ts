import { describe, expect, it } from 'vitest'
import { describePickerDialog } from '../ipc.js'

// `pickPath`'s real `dialog.showOpenDialog` call cannot be exercised from
// this suite (../ipc.ts's own header: `dialog` is a real Electron value
// import, untouched by anything ipc.test.ts calls) -- `describePickerDialog`
// is the pure text-building half, split out so the owner-approved wording
// (d-0032) has a real regression test rather than living only in a comment.

describe('describePickerDialog -- the folder shape (d-0032, owner-approved verbatim)', () => {
  it('names the app in the title and button label, and carries the full message including the load-bearing phrase', () => {
    const result = describePickerDialog({ directory: true, multiple: false, appName: 'Torrent App' })
    expect(result.title).toBe('Choose a folder for "Torrent App" to access')
    expect(result.buttonLabel).toBe('Allow access to this folder')
    expect(result.message).toBe(
      'This app will be able to read, change and delete everything in this folder, including files you add to it later.'
    )
  })

  it('the load-bearing phrase survives independent of the app name -- never trimmed', () => {
    const result = describePickerDialog({ directory: true, multiple: false, appName: undefined })
    expect(result.message).toContain('including files you add to it later')
  })

  it('falls back to a nameless title when no manifest was ever registered for the origin', () => {
    const result = describePickerDialog({ directory: true, multiple: false, appName: undefined })
    expect(result.title).toBe('Choose a folder to access')
  })
})

describe('describePickerDialog -- the file shapes (derived from d-0032\'s voice, not separately owner-reviewed)', () => {
  it('a single file: names what a FileHandle actually permits, no delete claim', () => {
    const result = describePickerDialog({ directory: false, multiple: false, appName: 'Torrent App' })
    expect(result.title).toBe('Choose a file for "Torrent App" to access')
    expect(result.buttonLabel).toBe('Allow access to this file')
    expect(result.message).toBe('This app will be able to read and change this file, including emptying it.')
  })

  it('multiple files: same voice, plural', () => {
    const result = describePickerDialog({ directory: false, multiple: true, appName: 'Torrent App' })
    expect(result.title).toBe('Choose files for "Torrent App" to access')
    expect(result.buttonLabel).toBe('Allow access to these files')
    expect(result.message).toBe('This app will be able to read and change these files, including emptying them.')
  })

  it('a nameless origin still gets a complete dialog, just without a quoted app name', () => {
    const result = describePickerDialog({ directory: false, multiple: false, appName: undefined })
    expect(result.title).toBe('Choose a file to access')
    expect(result.buttonLabel).toBe('Allow access to this file')
  })
})
