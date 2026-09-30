import { describe, expect, it } from 'vitest'
import type { DownloadEntry } from '../../../../main/downloads/download-types.js'
import { actionsFor, isRemovable, opensFile, spaceAction } from '../actions.js'

const entry = (over: Partial<DownloadEntry>): DownloadEntry => ({
  id: 'a', url: 'https://a.example/a', referrer: '', fileName: 'a', savePath: '/d/a', mime: '', total: 1, received: 1,
  state: 'completed', startedAt: 0, danger: false, ...over
})
const ids = (over: Partial<DownloadEntry>): string[] => actionsFor(entry(over)).map((action) => action.id)

describe('actionsFor', () => {
  it('offers pause and cancel to a running download, resume and cancel to a paused one', () => {
    expect(ids({ state: 'progressing' })).toEqual(['pause', 'cancel'])
    expect(ids({ state: 'paused' })).toEqual(['resume', 'cancel'])
  })

  it('offers a finished file its folder, its deletion and its removal from the list', () => {
    expect(ids({ state: 'completed' })).toEqual(['showInFolder', 'deleteFile', 'remove'])
    expect(ids({ state: 'completed', danger: true })).toEqual(['showInFolder', 'deleteFile', 'remove'])
  })

  it('offers retry and remove to a file that is gone, failed or cancelled', () => {
    expect(ids({ state: 'completed', missing: true })).toEqual(['retry', 'remove'])
    expect(ids({ state: 'interrupted' })).toEqual(['retry', 'remove'])
    expect(ids({ state: 'cancelled' })).toEqual(['retry', 'remove'])
  })

  it('asks for a second click only before deleting a file', () => {
    const confirming = actionsFor(entry({})).filter((action) => action.confirm !== undefined).map((action) => action.id)
    expect(confirming).toEqual(['deleteFile'])
  })
})

describe('opensFile, isRemovable and spaceAction', () => {
  it('lets a name open a finished, present file that is not dangerous', () => {
    expect(opensFile(entry({}))).toBe(true)
    expect(opensFile(entry({ danger: true }))).toBe(false)
    expect(opensFile(entry({ missing: true }))).toBe(false)
    expect(opensFile(entry({ state: 'progressing' }))).toBe(false)
  })

  it('removes with the keyboard only what is not running', () => {
    expect(isRemovable(entry({ state: 'progressing' }))).toBe(false)
    expect(isRemovable(entry({ state: 'paused' }))).toBe(false)
    expect(isRemovable(entry({ state: 'cancelled' }))).toBe(true)
    expect(isRemovable(entry({}))).toBe(true)
  })

  it('pauses and resumes with the space bar', () => {
    expect(spaceAction(entry({ state: 'progressing' }))).toBe('pause')
    expect(spaceAction(entry({ state: 'paused' }))).toBe('resume')
    expect(spaceAction(entry({}))).toBeNull()
  })
})
