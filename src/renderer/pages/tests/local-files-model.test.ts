import { describe, expect, it } from 'vitest'
import { isRows, localFileLine } from '../settings/local-files/local-files-model.js'

describe('localFileLine', () => {
  it('names the folder and marks a file that is gone from the disk', () => {
    expect(localFileLine({ id: 'a', path: '/home/u/notes/app.html', missing: false })).toEqual({ name: 'app.html', where: '/home/u/notes', missing: false })
    expect(localFileLine({ id: 'a', path: '/home/u/notes/app.html', missing: true })).toMatchObject({ missing: true })
    expect(localFileLine({ id: 'a', path: 'C:\\Users\\u\\app.html', missing: false })).toEqual({ name: 'app.html', where: 'C:\\Users\\u', missing: false })
  })
})

describe('isRows', () => {
  it('takes main\'s list and nothing that is shaped otherwise', () => {
    expect(isRows({ files: [{ id: 'a', path: '/x', missing: false }] })).toBe(true)
    expect(isRows({ files: [] })).toBe(true)
    expect(isRows({ files: [{ id: 'a', path: 7, missing: false }] })).toBe(false)
    expect(isRows(undefined)).toBe(false)
    expect(isRows({})).toBe(false)
  })
})
