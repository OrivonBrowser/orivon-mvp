// `dialog.showOpenDialog` and `showSaveDialog`, answering Electron's shape (`filePaths`, `filePath`) with
// stand-in paths (picked-paths.ts): the person's pick is reached through the path the dialog returns, and no
// host path ever reaches the page. The open dialog is Orivon's own picker (`orivon.fs.userSelected`); the save
// dialog is the web's `showSaveFilePicker`, which the permission gate already allows for one file. README.md's
// Design notes, "dialog", has what each Electron option becomes.

import { refuse } from './errors.js'
import { notConsidered, refusingProxy } from './unimplemented.js'
import { registerPickedDirectory, registerPickedFile } from './picked-paths.js'
import { fileHandleFromWeb, type WebFileHandle } from './web-file-handle.js'
import type { Orivon } from '../contracts/capability-api.js'

export interface FileFilter {
  readonly name: string
  readonly extensions: readonly string[]
}

export interface OpenDialogOptions {
  readonly properties?: readonly string[]
  readonly filters?: readonly FileFilter[]
  readonly title?: string
  readonly defaultPath?: string
  readonly buttonLabel?: string
  readonly message?: string
}

export interface OpenDialogReturnValue {
  readonly canceled: boolean
  readonly filePaths: readonly string[]
}

export interface SaveDialogOptions {
  readonly title?: string
  readonly defaultPath?: string
  readonly buttonLabel?: string
  readonly filters?: readonly FileFilter[]
  readonly message?: string
  readonly nameFieldLabel?: string
  readonly showsTagField?: boolean
  readonly properties?: readonly string[]
}

export interface SaveDialogReturnValue {
  readonly canceled: boolean
  readonly filePath: string
}

export interface ElectronDialog {
  showOpenDialog(options: OpenDialogOptions): Promise<OpenDialogReturnValue>
  showOpenDialog(window: unknown, options: OpenDialogOptions): Promise<OpenDialogReturnValue>
  showSaveDialog(options: SaveDialogOptions): Promise<SaveDialogReturnValue>
  showSaveDialog(window: unknown, options: SaveDialogOptions): Promise<SaveDialogReturnValue>
  showOpenDialogSync(...args: readonly unknown[]): never
  showSaveDialogSync(...args: readonly unknown[]): never
}

interface SaveFilePickerOptions {
  suggestedName?: string
  types?: Array<{ description: string, accept: Record<string, string[]> }>
}

export interface DialogDeps {
  /** The page's `showSaveFilePicker`, read when a save dialog is asked for; `undefined` where the page has none. */
  readonly saveFilePicker: () => ((options: SaveFilePickerOptions) => Promise<WebFileHandle>) | undefined
  /** Says once what an option did, in the console. */
  readonly warn: (message: string) => void
}

/** The name a picked file carries in its stand-in path when its handle reports none. */
export const PICKED_FILE_NAME = 'picked-file'

const OPEN_MAPPED = new Set(['openFile', 'openDirectory', 'multiSelections'])
const REQUEST_REFUSED = 'it needs a click or key press a moment before the call, and an app that holds the fs capability'

function optionsOf (args: readonly unknown[]): Record<string, unknown> {
  const options = args.length >= 2 ? args[1] : args[0]
  return typeof options === 'object' && options !== null ? options as Record<string, unknown> : {}
}

function isNamed (error: unknown, ...names: readonly string[]): boolean {
  return typeof error === 'object' && error !== null && names.includes((error as { name?: string }).name ?? '')
}

function lastSegment (path: string): string {
  return path.split(/[\\/]/).filter((part) => part !== '').at(-1) ?? ''
}

/** A web `accept` map from Electron's filters: a filter with no usable extension (`*`, or none) adds nothing. */
function pickerTypes (filters: unknown): SaveFilePickerOptions['types'] {
  if (!Array.isArray(filters)) return undefined
  const types: NonNullable<SaveFilePickerOptions['types']> = []
  for (const filter of filters as Array<{ name?: unknown, extensions?: unknown }>) {
    const extensions = (Array.isArray(filter.extensions) ? filter.extensions as unknown[] : [])
      .filter((extension): extension is string => typeof extension === 'string' && /^[A-Za-z0-9]{1,16}$/.test(extension))
      .map((extension) => `.${extension}`)
    if (extensions.length > 0) types.push({ description: typeof filter.name === 'string' ? filter.name : '', accept: { 'application/octet-stream': extensions } })
  }
  return types.length > 0 ? types : undefined
}

export function createDialog (orivon: Pick<Orivon, 'fs'>, deps: DialogDeps = defaultDeps()): ElectronDialog {
  const warned = new Set<string>()
  const notApplied = (api: string, names: readonly string[], why: string): void => {
    const message = `${api}: ${names.join(', ')} ${why}`
    if (names.length > 0 && !warned.has(message)) { warned.add(message); deps.warn(message) }
  }
  const present = (options: Record<string, unknown>, names: readonly string[]): string[] => names.filter((name) => options[name] !== undefined)

  async function showOpenDialog (...args: readonly unknown[]): Promise<OpenDialogReturnValue> {
    const options = optionsOf(args)
    const properties = Array.isArray(options['properties']) ? (options['properties'] as unknown[]).filter((p): p is string => typeof p === 'string') : []
    const directory = properties.includes('openDirectory')
    notApplied('dialog.showOpenDialog', present(options, ['filters', 'defaultPath', 'title', 'buttonLabel', 'message']),
      'are not applied: Orivon shows its own picker, worded to name the app that asks, and the choice is not filtered')
    notApplied('dialog.showOpenDialog', properties.filter((property) => !OPEN_MAPPED.has(property)), "are not applied: the picker is Orivon's own")
    if (directory) notApplied('dialog.showOpenDialog', properties.includes('multiSelections') ? ['multiSelections'] : [], 'does not apply to a folder: one folder is picked')
    try {
      if (directory) {
        const handle = await orivon.fs.userSelected({ directory: true })
        return handle === null ? { canceled: true, filePaths: [] } : { canceled: false, filePaths: [registerPickedDirectory(handle)] }
      }
      const handles = await orivon.fs.userSelected({ multiple: properties.includes('multiSelections') })
      return handles.length === 0
        ? { canceled: true, filePaths: [] }
        : { canceled: false, filePaths: handles.map((handle) => registerPickedFile(handle, handle.name ?? PICKED_FILE_NAME)) }
    } catch (error) {
      if ((error as { code?: string }).code === 'denied') {
        throw refuse('dialog.showOpenDialog', 'invalid-usage', `Orivon refused to show the picker: ${REQUEST_REFUSED}.`)
      }
      throw error
    }
  }

  async function showSaveDialog (...args: readonly unknown[]): Promise<SaveDialogReturnValue> {
    const options = optionsOf(args)
    notApplied('dialog.showSaveDialog', present(options, ['title', 'buttonLabel', 'message', 'nameFieldLabel', 'showsTagField', 'properties']),
      "are not applied: the browser's own save dialog is shown")
    const picker = deps.saveFilePicker()
    if (picker === undefined) {
      throw refuse('dialog.showSaveDialog', 'unimplemented',
        'this page has no showSaveFilePicker, which dialog.showSaveDialog is built on; it exists in a secure context only.')
    }
    const suggested = typeof options['defaultPath'] === 'string' ? lastSegment(options['defaultPath']) : ''
    const request: SaveFilePickerOptions = {}
    if (suggested !== '') request.suggestedName = suggested
    const types = pickerTypes(options['filters'])
    if (types !== undefined) request.types = types
    let web: WebFileHandle
    try {
      web = await picker(request)
    } catch (error) {
      if (isNamed(error, 'AbortError')) return { canceled: true, filePath: '' }
      if (isNamed(error, 'SecurityError', 'NotAllowedError')) {
        throw refuse('dialog.showSaveDialog', 'invalid-usage', 'the browser refused to show the save dialog: it needs a click or key press a moment before the call.')
      }
      throw error
    }
    return { canceled: false, filePath: registerPickedFile(fileHandleFromWeb(web), web.name) }
  }

  const syncRefusal = (api: string) => (): never => {
    throw refuse(api, 'desktop-shell',
      `${api} would block the page until the person answers, which a page cannot do. Use ${api.replace(/Sync$/, '')}, which returns a promise.`)
  }

  const known = {
    showOpenDialog,
    showSaveDialog,
    showOpenDialogSync: syncRefusal('dialog.showOpenDialogSync'),
    showSaveDialogSync: syncRefusal('dialog.showSaveDialogSync')
  } as ElectronDialog
  return refusingProxy(known, (prop) => notConsidered(`dialog.${prop}`))
}

function defaultDeps (): DialogDeps {
  return {
    saveFilePicker: () => {
      const picker = (globalThis as { showSaveFilePicker?: (options: SaveFilePickerOptions) => Promise<WebFileHandle> }).showSaveFilePicker
      return picker === undefined ? undefined : picker.bind(globalThis)
    },
    warn: (message) => { console.warn(message) }
  }
}
