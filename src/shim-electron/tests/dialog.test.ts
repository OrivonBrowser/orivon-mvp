import { describe, expect, it, vi } from 'vitest'
import { createDialog, PICKED_FILE_NAME, type DialogDeps } from '../dialog.js'
import { ElectronShimError } from '../errors.js'
import { PICKED_ROOT, resolvePickedPath } from '../picked-paths.js'
import type { WebFileHandle, WebWritable } from '../web-file-handle.js'
import type { Orivon } from '../../contracts/capability-api.js'
import type { DirectoryHandle, FileHandle } from '../../contracts/handles.js'

const fileHandle = (): FileHandle => ({ id: 'f', closed: new Promise(() => {}) }) as unknown as FileHandle
const directoryHandle = (): DirectoryHandle => ({ id: 'd', closed: new Promise(() => {}) }) as unknown as DirectoryHandle

function setup (userSelected: (opts?: unknown) => Promise<unknown>, picker?: DialogDeps['saveFilePicker']) {
  const warnings: string[] = []
  const orivon = { fs: { userSelected } } as unknown as Pick<Orivon, 'fs'>
  const dialog = createDialog(orivon, { saveFilePicker: picker ?? (() => undefined), warn: (message) => { warnings.push(message) } })
  return { dialog, warnings }
}

describe('dialog.showOpenDialog', () => {
  it('openFile asks for one file and answers one stand-in path under the picked root', async () => {
    const userSelected = vi.fn(async () => [fileHandle()])
    const { dialog } = setup(userSelected)
    const result = await dialog.showOpenDialog({ properties: ['openFile'] })
    expect(userSelected).toHaveBeenCalledWith({ multiple: false })
    expect(result.canceled).toBe(false)
    expect(result.filePaths).toHaveLength(1)
    expect(result.filePaths[0]?.startsWith(`${PICKED_ROOT}/`)).toBe(true)
    expect(result.filePaths[0]?.endsWith(`/${PICKED_FILE_NAME}`)).toBe(true)
    expect(resolvePickedPath(result.filePaths[0] as string)?.status).toBe('pick')
  })

  it('multiSelections asks for several and answers a path per file, each its own pick', async () => {
    const userSelected = vi.fn(async () => [fileHandle(), fileHandle(), fileHandle()])
    const { dialog } = setup(userSelected)
    const result = await dialog.showOpenDialog({ properties: ['openFile', 'multiSelections'] })
    expect(userSelected).toHaveBeenCalledWith({ multiple: true })
    expect(new Set(result.filePaths).size).toBe(3)
  })

  it('with no property it picks a file, as the picker\'s default', async () => {
    const userSelected = vi.fn(async () => [fileHandle()])
    await setup(userSelected).dialog.showOpenDialog({})
    expect(userSelected).toHaveBeenCalledWith({ multiple: false })
  })

  it('openDirectory asks for a folder and answers the folder\'s stand-in', async () => {
    const userSelected = vi.fn(async () => directoryHandle())
    const { dialog } = setup(userSelected)
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    expect(userSelected).toHaveBeenCalledWith({ directory: true })
    expect(result.filePaths).toHaveLength(1)
    expect(result.filePaths[0]).toMatch(new RegExp(`^${PICKED_ROOT}/[0-9a-f]+$`))
    expect(resolvePickedPath(result.filePaths[0] as string)).toMatchObject({ status: 'pick', entry: { kind: 'directory' } })
  })

  it('with both openFile and openDirectory it picks a folder, as Windows and Linux dialogs do', async () => {
    const userSelected = vi.fn(async () => directoryHandle())
    await setup(userSelected).dialog.showOpenDialog({ properties: ['openFile', 'openDirectory'] })
    expect(userSelected).toHaveBeenCalledWith({ directory: true })
  })

  it('a cancelled picker answers canceled with no paths, for a file and for a folder', async () => {
    expect(await setup(async () => []).dialog.showOpenDialog({ properties: ['openFile'] })).toEqual({ canceled: true, filePaths: [] })
    expect(await setup(async () => null).dialog.showOpenDialog({ properties: ['openDirectory'] })).toEqual({ canceled: true, filePaths: [] })
  })

  it('takes the window first, as Electron does, and ignores it', async () => {
    const userSelected = vi.fn(async () => [fileHandle()])
    const result = await setup(userSelected).dialog.showOpenDialog({ some: 'window' }, { properties: ['openFile'] })
    expect(result.canceled).toBe(false)
  })

  it('says once which options it did not apply, and which Electron properties are the picker\'s own', async () => {
    const { dialog, warnings } = setup(async () => [fileHandle()])
    const options = { properties: ['openFile', 'showHiddenFiles'], filters: [{ name: 'Video', extensions: ['mp4'] }], defaultPath: '/home/x', title: 'Pick' }
    await dialog.showOpenDialog(options)
    await dialog.showOpenDialog(options)
    expect(warnings).toHaveLength(2)
    expect(warnings[0]).toMatch(/filters, defaultPath, title are not applied/)
    expect(warnings[1]).toMatch(/showHiddenFiles are not applied/)
  })

  it('a refused picker (no click, or no fs) rejects naming the click, instead of looking like a cancel', async () => {
    const denied = Object.assign(new Error('needs a user gesture'), { code: 'denied' })
    const { dialog } = setup(async () => { throw denied })
    const error = await dialog.showOpenDialog({}).catch((caught: unknown) => caught) as ElectronShimError
    expect(error).toBeInstanceOf(ElectronShimError)
    expect(error.reason).toBe('invalid-usage')
    expect(error.message).toMatch(/click or key press/)
  })

  it('any other failure of the picker passes through untouched', async () => {
    const failure = Object.assign(new Error('the OS picker could not be shown'), { code: 'internal' })
    await expect(setup(async () => { throw failure }).dialog.showOpenDialog({})).rejects.toBe(failure)
  })

  it('rejects rather than throws synchronously, as Electron\'s promise-returning method does', async () => {
    const { dialog } = setup(async () => [])
    let synchronous: unknown
    let result: Promise<unknown> | undefined
    try { result = dialog.showOpenDialog({}) } catch (error) { synchronous = error }
    expect(synchronous).toBeUndefined()
    await expect(result).resolves.toBeDefined()
  })
})

describe('dialog.showSaveDialog', () => {
  function webFile (name: string) {
    const writable: WebWritable = { write: vi.fn(async () => {}), truncate: vi.fn(async () => {}), close: vi.fn(async () => {}) }
    const handle: WebFileHandle = { name, getFile: vi.fn(), createWritable: vi.fn(async () => writable) }
    return { handle, writable }
  }

  it('shows the browser\'s save picker with the default name and answers a stand-in path ending in the saved name', async () => {
    const { handle } = webFile('export.json')
    const picker = vi.fn(async () => handle)
    const { dialog } = setup(async () => [], () => picker)
    const result = await dialog.showSaveDialog({ defaultPath: '/home/someone/Documents/export.json' })
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'export.json' })
    expect(result.canceled).toBe(false)
    expect(result.filePath).toMatch(new RegExp(`^${PICKED_ROOT}/[0-9a-f]+/export\\.json$`))
    expect(resolvePickedPath(result.filePath)).toMatchObject({ status: 'pick', entry: { kind: 'file', name: 'export.json' } })
  })

  it('a Windows default path gives its last segment', async () => {
    const picker = vi.fn(async () => webFile('a.txt').handle)
    await setup(async () => [], () => picker).dialog.showSaveDialog({ defaultPath: 'C:\\Users\\me\\a.txt' })
    expect(picker).toHaveBeenCalledWith({ suggestedName: 'a.txt' })
  })

  it('maps filters to the picker\'s types and leaves a wildcard out', async () => {
    const picker = vi.fn(async () => webFile('a.csv').handle)
    await setup(async () => [], () => picker).dialog.showSaveDialog({
      filters: [{ name: 'Spreadsheet', extensions: ['csv', 'tsv'] }, { name: 'All files', extensions: ['*'] }, { name: 'Odd', extensions: ['a/b'] }]
    })
    expect(picker).toHaveBeenCalledWith({ types: [{ description: 'Spreadsheet', accept: { 'application/octet-stream': ['.csv', '.tsv'] } }] })
  })

  it('a dismissed picker answers canceled with an empty path, as Electron does', async () => {
    const abort = Object.assign(new Error('aborted'), { name: 'AbortError' })
    const { dialog } = setup(async () => [], () => async () => { throw abort })
    expect(await dialog.showSaveDialog({})).toEqual({ canceled: true, filePath: '' })
  })

  it('without a click the browser refuses, and that rejects naming the click instead of looking like a cancel', async () => {
    const refused = Object.assign(new Error('must be handling a user gesture'), { name: 'SecurityError' })
    const { dialog } = setup(async () => [], () => async () => { throw refused })
    const error = await dialog.showSaveDialog({}).catch((caught: unknown) => caught) as ElectronShimError
    expect(error).toBeInstanceOf(ElectronShimError)
    expect(error.reason).toBe('invalid-usage')
  })

  it('a page with no showSaveFilePicker rejects by name', async () => {
    const { dialog } = setup(async () => [])
    const error = await dialog.showSaveDialog({}).catch((caught: unknown) => caught) as ElectronShimError
    expect(error).toBeInstanceOf(ElectronShimError)
    expect(error.reason).toBe('unimplemented')
    expect(error.api).toBe('dialog.showSaveDialog')
  })

  it('says once which options it did not apply', async () => {
    const { dialog, warnings } = setup(async () => [], () => async () => webFile('a').handle)
    await dialog.showSaveDialog({ title: 'Save', buttonLabel: 'Go' })
    await dialog.showSaveDialog({ title: 'Save', buttonLabel: 'Go' })
    expect(warnings).toEqual(["dialog.showSaveDialog: title, buttonLabel are not applied: the browser's own save dialog is shown"])
  })
})

describe('the rest of dialog', () => {
  it.each(['showOpenDialogSync', 'showSaveDialogSync'])('dialog.%s refuses by name and points at the promise form', (method) => {
    const dialog = setup(async () => []).dialog as unknown as Record<string, () => unknown>
    let caught: ElectronShimError | undefined
    try { dialog[method]!() } catch (error) { caught = error as ElectronShimError }
    expect(caught).toBeInstanceOf(ElectronShimError)
    expect(caught?.api).toBe(`dialog.${method}`)
    expect(caught?.reason).toBe('desktop-shell')
    expect(caught?.message).toContain(method.replace(/Sync$/, ''))
  })

  it.each(['showMessageBox', 'showErrorBox', 'somethingNotRealEither'])(
    'dialog.%s: reading it is safe (A169); calling it throws a named, not-yet-considered error rather than a bare TypeError',
    (method) => {
      const dialog = setup(async () => []).dialog as unknown as Record<string, () => unknown>
      expect(() => dialog[method]).not.toThrow()
      expect(() => dialog[method]!()).toThrow(ElectronShimError)
      try {
        dialog[method]!()
      } catch (error) {
        expect((error as Error).name).not.toBe('TypeError')
        expect((error as ElectronShimError).reason).toBe('unimplemented')
        expect((error as ElectronShimError).api).toBe(`dialog.${method}`)
      }
    }
  )
})
