import { describe, expect, it } from 'vitest'
import { rendererEntryUrl, upperDriveLetter } from '../renderer-entry.js'

describe('rendererEntryUrl', () => {
  it('serves an entry off the dev server at its nested path', () => {
    expect(rendererEntryUrl('/out/main', 'http://localhost:5173', '/newtab/', '../renderer/newtab/index.html')).toBe('http://localhost:5173/newtab/')
  })

  it('resolves the built file to a file URL otherwise', () => {
    expect(rendererEntryUrl('/opt/orivon/out/main', undefined, '/', '../renderer/index.html')).toBe('file:///opt/orivon/out/renderer/index.html')
  })
})

describe('upperDriveLetter', () => {
  it('writes a Windows drive letter the way Chromium reports it', () => {
    expect(upperDriveLetter('file:///c:/Users/x/out/renderer/index.html')).toBe('file:///C:/Users/x/out/renderer/index.html')
  })

  it('leaves an upper-case drive, a POSIX path and a non-file URL alone', () => {
    expect(upperDriveLetter('file:///D:/a/index.html')).toBe('file:///D:/a/index.html')
    expect(upperDriveLetter('file:///opt/c:/index.html')).toBe('file:///opt/c:/index.html')
    expect(upperDriveLetter('http://localhost:5173/')).toBe('http://localhost:5173/')
  })
})
