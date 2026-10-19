// Bundled against the shim by ./e2e-app-picked-paths.test.ts into a fixture page's script: a Node-shaped
// Electron app that asks `dialog` for a file, a folder and a save target, and then does what such an app
// does with the paths it gets back, using `fs` alone. A button runs the scenario the test set, so the dialog
// is called from a click as a real app's is. Results land in `window.__r`.

import * as fs from 'fs'
import { dialog } from 'electron'

type Scenario = 'openFile' | 'openFolder' | 'save'
interface PageGlobals {
  __r: Record<string, unknown>
  __scenario: Scenario
  showSaveFilePicker?: (options: unknown) => Promise<unknown>
}
const page = window as unknown as PageGlobals
page.__r = {}
// No path in this page may open a native save window: the real picker is replaced before anything runs, and the save scenario installs its own stand-in.
page.showSaveFilePicker = async () => { throw Object.assign(new Error('the native save picker is never opened by this spec'), { name: 'SecurityError' }) }

const fail = (error: unknown): string => `${(error as { code?: string }).code ?? (error as Error).name}: ${(error as Error).message}`

async function collect (path: string): Promise<string> {
  return await new Promise((resolve, reject) => {
    let out = ''
    const stream = fs.createReadStream(path, { encoding: 'utf8' })
    stream.on('data', (chunk) => { out += String(chunk) })
    stream.on('end', () => { resolve(out) })
    stream.on('error', reject)
  })
}

async function openFile (): Promise<void> {
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openFile'], filters: [{ name: 'All', extensions: ['*'] }] })
  const path = filePaths[0] as string
  const stat = await fs.promises.stat(path)
  const read = await fs.promises.readFile(path, 'utf8')
  const streamed = await collect(path)
  await fs.promises.writeFile(path, 'rewritten by the app')
  const again = await fs.promises.readFile(path, 'utf8')
  await fs.promises.writeFile('plain.txt', 'in the app files')
  page.__r['openFile'] = { canceled, path, size: stat.size, isFile: stat.isFile(), read, streamed, again, plain: await fs.promises.readFile('plain.txt', 'utf8') }
}

async function openFolder (): Promise<void> {
  const { canceled, filePaths } = await dialog.showOpenDialog({ properties: ['openDirectory'] })
  const root = filePaths[0] as string
  const names = await fs.promises.readdir(root)
  const text = await fs.promises.readFile(`${root}/a.txt`, 'utf8')
  await fs.promises.mkdir(`${root}/out/deep`, { recursive: true })
  await fs.promises.writeFile(`${root}/out/deep/b.txt`, 'written into the folder')
  await new Promise<void>((resolve, reject) => {
    const stream = fs.createWriteStream(`${root}/streamed.txt`)
    stream.on('close', resolve)
    stream.on('error', reject)
    stream.end('streamed into the folder')
  })
  const nested = await fs.promises.readdir(`${root}/out`, { withFileTypes: true })
  const escapes: Record<string, string> = {}
  for (const [label, path] of [['up', `${root}/../../../../etc/hostname`], ['absolute', '/etc/hostname'], ['sibling-pick', `${root}/..`]] as const) {
    escapes[label] = await fs.promises.readFile(path, 'utf8').then(() => 'read', fail)
  }
  page.__r['openFolder'] = { canceled, root, names, text, nested: nested.map((entry) => [entry.name, entry.isDirectory()]), escapes }
}

async function save (): Promise<void> {
  const saved: { suggestedName: string | undefined } = { suggestedName: undefined }
  const root = await navigator.storage.getDirectory()
  page.showSaveFilePicker = async (options) => {
    saved.suggestedName = (options as { suggestedName?: string }).suggestedName
    return await root.getFileHandle(saved.suggestedName ?? 'saved', { create: true })
  }
  const { canceled, filePath } = await dialog.showSaveDialog({ defaultPath: '/home/someone/export.json', filters: [{ name: 'JSON', extensions: ['json'] }] })
  await fs.promises.mkdir(filePath.slice(0, filePath.lastIndexOf('/')), { recursive: true })
  await fs.promises.writeFile(filePath, '{"saved":true}')
  await fs.promises.appendFile(filePath, '\n')
  const onDisk = await (await (await root.getFileHandle('export.json')).getFile()).text()
  page.__r['save'] = { canceled, filePath, suggestedName: saved.suggestedName, onDisk, readBack: await fs.promises.readFile(filePath, 'utf8') }
}

const scenarios: Record<Scenario, () => Promise<void>> = { openFile, openFolder, save }

document.getElementById('go')?.addEventListener('click', () => {
  const name = page.__scenario
  scenarios[name]().catch((error: unknown) => { page.__r[name] = `ERR ${fail(error)}` })
})

/** What the test asks of the page outside a click: a call with no user gesture, and the paths a reload left behind. */
;(window as unknown as { probe: unknown }).probe = {
  // After a pause: the driver's own evaluate counts as a user gesture, and a gesture lasts a few seconds.
  withoutClickLater: (pauseMs: number) => {
    const rejection = (error: Error & { reason?: string }): string => `${error.name}:${error.reason ?? ''}:${error.message}`
    setTimeout(() => {
      void (async () => {
        const open = await dialog.showOpenDialog({ properties: ['openFile'] }).then(() => 'resolved', rejection)
        const saveFilePicker = typeof (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker
        const save = await dialog.showSaveDialog({}).then(() => 'resolved', rejection)
        page.__r['withoutClick'] = { open, save, saveFilePicker }
      })()
    }, pauseMs)
  },
  staleRead: async (path: string) => await fs.promises.readFile(path).then(() => 'read', fail),
  staleStream: async (path: string) => await new Promise<string>((resolve) => { fs.createReadStream(path).on('error', (error) => { resolve(fail(error)) }) }),
  syncRead: (path: string) => { try { fs.readFileSync(path); return 'read' } catch (error) { return fail(error) } }
}
