import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BaseWindow } from 'electron'

const dialog = vi.hoisted(() => ({ showSaveDialog: vi.fn(), showOpenDialog: vi.fn() }))
vi.mock('electron', () => ({ dialog }))

const { pickFolder, pickOpenFile, pickSaveFile } = await import('../file-dialogs.js')

const live = { isDestroyed: () => false } as unknown as BaseWindow
const gone = { isDestroyed: () => true } as unknown as BaseWindow

beforeEach(() => { dialog.showSaveDialog.mockReset(); dialog.showOpenDialog.mockReset() })

describe('pickSaveFile', () => {
  it('answers the chosen path, over the window when it is open', async () => {
    dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/a.pdf' })
    expect(await pickSaveFile(live, { title: 'Save' })).toBe('/tmp/a.pdf')
    expect(dialog.showSaveDialog).toHaveBeenCalledWith(live, { title: 'Save' })
  })

  it('opens without a parent when the window is gone or absent', async () => {
    dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '/tmp/a.pdf' })
    await pickSaveFile(gone, {})
    await pickSaveFile(undefined, {})
    expect(dialog.showSaveDialog.mock.calls.map((call) => call.length)).toEqual([1, 1])
  })

  it('answers nothing on cancel or an empty path', async () => {
    dialog.showSaveDialog.mockResolvedValue({ canceled: true, filePath: '' })
    expect(await pickSaveFile(live, {})).toBeUndefined()
    dialog.showSaveDialog.mockResolvedValue({ canceled: false, filePath: '' })
    expect(await pickSaveFile(live, {})).toBeUndefined()
  })

  it('reads dialog.showSaveDialog when called, so a test can replace it', async () => {
    const replaced = vi.fn(async () => ({ canceled: false, filePath: '/x' }))
    dialog.showSaveDialog = replaced
    expect(await pickSaveFile(live, {})).toBe('/x')
    expect(replaced).toHaveBeenCalledTimes(1)
  })
})

describe('pickOpenFile and pickFolder', () => {
  it('ask for one file, and one folder, whatever the caller adds', async () => {
    dialog.showOpenDialog.mockResolvedValue({ canceled: false, filePaths: ['/tmp/one', '/tmp/two'] })
    expect(await pickOpenFile(live, { properties: ['multiSelections', 'showHiddenFiles'] })).toBe('/tmp/one')
    expect(dialog.showOpenDialog.mock.calls[0]?.[1]).toEqual({ properties: ['openFile', 'showHiddenFiles'] })
    expect(await pickFolder(undefined, { properties: ['openFile', 'createDirectory'] })).toBe('/tmp/one')
    expect(dialog.showOpenDialog.mock.calls[1]?.[0]).toEqual({ properties: ['openDirectory', 'createDirectory'] })
  })

  it('answer nothing on cancel', async () => {
    dialog.showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] })
    expect(await pickOpenFile(live, {})).toBeUndefined()
    expect(await pickFolder(live, {})).toBeUndefined()
  })
})
