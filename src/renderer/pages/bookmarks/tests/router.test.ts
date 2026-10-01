import { describe, expect, it } from 'vitest'
import { DEFAULT_FOLDER, folderFromPath, pathForFolder } from '../router.js'

describe('the page address', () => {
  it('reads a folder id from /folder/<id>', () => {
    expect(folderFromPath('/folder/abc123')).toBe('abc123')
    expect(folderFromPath('/folder/abc123/')).toBe('abc123')
    expect(folderFromPath('/folder/other')).toBe('other')
  })

  it('names no folder for anything else', () => {
    expect(folderFromPath('/')).toBeNull()
    expect(folderFromPath('')).toBeNull()
    expect(folderFromPath('/folder/')).toBeNull()
    expect(folderFromPath('/folder/a/b')).toBeNull()
    expect(folderFromPath('/folder/../x')).toBeNull()
    expect(folderFromPath('/folder/a b')).toBeNull()
    expect(folderFromPath(`/folder/${'x'.repeat(33)}`)).toBeNull()
  })

  it('writes the bar as the bare address and any other folder with its id', () => {
    expect(pathForFolder(DEFAULT_FOLDER)).toBe('/')
    expect(pathForFolder('abc123')).toBe('/folder/abc123')
    expect(folderFromPath(pathForFolder('abc123'))).toBe('abc123')
  })
})
