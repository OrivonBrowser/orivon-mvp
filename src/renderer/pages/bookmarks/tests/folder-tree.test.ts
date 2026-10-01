import { describe, expect, it } from 'vitest'
import { folderBranch, parentFolder, visibleFolders } from '../folder-tree.js'
import type { FolderInfo } from '../folder-tree.js'

const f = (id: string, depth: number, folders = 0): FolderInfo => ({ id, title: id, depth, folders, items: 0 })
const tree = [f('bar', 0, 2), f('work', 1, 1), f('deep', 2), f('play', 1), f('other', 0)]

describe('the folder tree', () => {
  it('shows a folder only when every folder above it is open', () => {
    expect(visibleFolders(tree, new Set(['bar', 'other'])).map((folder) => folder.id)).toEqual(['bar', 'work', 'play', 'other'])
    expect(visibleFolders(tree, new Set(['bar', 'work'])).map((folder) => folder.id)).toEqual(['bar', 'work', 'deep', 'play', 'other'])
    expect(visibleFolders(tree, new Set()).map((folder) => folder.id)).toEqual(['bar', 'other'])
  })

  it('knows a folder with everything inside it', () => {
    expect([...folderBranch(tree, 'work')]).toEqual(['work', 'deep'])
    expect([...folderBranch(tree, 'bar')]).toEqual(['bar', 'work', 'deep', 'play'])
    expect([...folderBranch(tree, 'nope')]).toEqual([])
  })

  it('knows the folder above', () => {
    expect(parentFolder(tree, 'deep')?.id).toBe('work')
    expect(parentFolder(tree, 'play')?.id).toBe('bar')
    expect(parentFolder(tree, 'other')).toBeNull()
    expect(parentFolder(tree, 'nope')).toBeNull()
  })
})
