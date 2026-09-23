// The permission gate's `fileSystem` rule, proved against a real page and a
// real file on disk rather than against the handler in isolation: the gate
// is `critical: true`, so an allow that only unit tests have seen is not
// proven at all.
//
// DELIBERATELY AN ORDINARY WEBSITE, not an Orivon app: File System Access is
// a web-platform power the person grants by choosing a file, not an
// `orivon.*` capability, and the deny this file guards broke every site in
// the browser, not only ported apps.
//
// THE FILE ARRIVES BY DRAG AND DROP, NOT THROUGH A PICKER. A picker is a
// native OS dialog, which a headless run cannot answer and which, through
// the desktop portal, could open on a real screen. A dropped file reaches
// the same check handler with the same details a picked one does, so the
// drop exercises the gate itself; only the dialog is left out.
//
// Hermetic: one throwaway server on loopback and one temp directory.
import { afterAll, expect, it } from 'vitest'
import { createServer, type Server } from 'node:http'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assertNoElectronSurvivors, launchElectron, DEFAULT_ACTION_TIMEOUT_MS } from './launch-electron.mjs'
import { HERMETIC_RESOLVER, evaluateRetrying } from './smoke-helpers.mjs'
import { ADDRESS_BAR_STABLE_TIMEOUT_MS, APP_CLOSE_RACE_MS, closeElectronApp, navigateToFixture, runPhase } from './e2e-helpers.js'

const HOST = '127.0.0.1'
// 8872-8884 are taken by the fixture apps and the other e2e files.
const PORT = 8885
const ORIGIN = `http://${HOST}:${PORT}/`
const TITLE = 'file access fixture'

// A drop zone covering the page. getAsFileSystemHandle() must be called
// inside the drop event, before the DataTransfer is torn down, so the
// handles are collected synchronously and awaited afterwards.
const PAGE = `<!doctype html><meta charset="utf-8"><title>${TITLE}</title>
<body style="margin:0">
<div id="drop" style="position:fixed;inset:0"></div>
<script>
  window.__dropped = undefined
  const zone = document.getElementById('drop')
  zone.addEventListener('dragover', (e) => e.preventDefault())
  zone.addEventListener('drop', (e) => {
    e.preventDefault()
    const pending = [...e.dataTransfer.items].map((item) => item.getAsFileSystemHandle())
    Promise.all(pending).then((handles) => { window.__dropped = handles })
  })
</script>
</body>`

interface DropWindow { __dropped: FileSystemHandle[] | undefined }

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS =
  ADDRESS_BAR_STABLE_TIMEOUT_MS + DEFAULT_ACTION_TIMEOUT_MS * 4 + APP_CLOSE_RACE_MS + 30_000

it('lets an ordinary website read and write a file the person handed it, and refuses a directory', async () => {
  await runPhase('file-system-access', async (check) => {
    let app: Awaited<ReturnType<typeof launchElectron>> | undefined
    let server: Server | undefined
    const dir = mkdtempSync(join(tmpdir(), 'orivon-fsa-e2e-'))
    const file = join(dir, 'export.txt')
    const folder = join(dir, 'folder')
    const inner = join(folder, 'inner.txt')
    writeFileSync(file, 'before')
    mkdirSync(folder)
    writeFileSync(inner, 'untouched')
    try {
      server = createServer((_req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
        res.end(PAGE)
      })
      await new Promise<void>((resolve) => { server?.listen(PORT, HOST, resolve) })
      check('a plain page with a drop zone is served over loopback HTTP, with no manifest', true)

      app = await launchElectron({ appPath: '.', args: [HERMETIC_RESOLVER] })
      const view = await navigateToFixture(app, ORIGIN, TITLE)
      const cdp = await view.context().newCDPSession(view)

      /** Drops `path` onto the page the way a person dragging it from a file manager would. */
      async function drop (path: string): Promise<string> {
        await view.evaluate(() => { (window as unknown as DropWindow).__dropped = undefined })
        const data = { items: [], files: [path], dragOperationsMask: 1 }
        for (const type of ['dragEnter', 'dragOver', 'drop'] as const) {
          await cdp.send('Input.dispatchDragEvent', { type, x: 100, y: 100, data })
        }
        await view.waitForFunction(() => (window as unknown as DropWindow).__dropped !== undefined)
        return await evaluateRetrying(view, () => (window as unknown as DropWindow).__dropped?.map((h) => h.kind).join(','))
      }

      const fileKind = await drop(file)
      check(`the dropped file arrives as a file handle (got ${String(fileKind)})`, fileKind === 'file')

      const read = await evaluateRetrying(view, async () => {
        const handle = (window as unknown as DropWindow).__dropped?.[0] as FileSystemFileHandle
        try { return await (await handle.getFile()).text() } catch (e) { return `${(e as Error).name}: ${(e as Error).message}` }
      })
      check(`getFile() reads it (got ${String(read)})`, read === 'before')

      // The export path: createWritable() is what the deny broke.
      const write = await evaluateRetrying(view, async () => {
        const handle = (window as unknown as DropWindow).__dropped?.[0] as FileSystemFileHandle
        try {
          const writable = await handle.createWritable()
          await writable.write('after')
          await writable.close()
          return 'written'
        } catch (e) { return `${(e as Error).name}: ${(e as Error).message}` }
      })
      const onDisk = readFileSync(file, 'utf8')
      check(`createWritable() writes it (got ${String(write)}, file now holds "${onDisk}")`, write === 'written' && onDisk === 'after')

      const folderKind = await drop(folder)
      check(`the dropped folder arrives as a directory handle (got ${String(folderKind)})`, folderKind === 'directory')

      // A directory grant would reach every file beneath it, so listing,
      // and reaching a child to write it, must both be refused.
      const listing = await evaluateRetrying(view, async () => {
        const handle = (window as unknown as DropWindow).__dropped?.[0] as FileSystemDirectoryHandle
        try {
          for await (const entry of handle.values()) void entry
          return 'LISTED'
        } catch (e) { return (e as Error).name }
      })
      check(`listing the directory is refused (got ${String(listing)})`, listing === 'NotAllowedError')

      const child = await evaluateRetrying(view, async () => {
        const handle = (window as unknown as DropWindow).__dropped?.[0] as FileSystemDirectoryHandle
        try {
          const innerHandle = await handle.getFileHandle('inner.txt')
          const writable = await innerHandle.createWritable()
          await writable.write('overwritten')
          await writable.close()
          return 'WRITTEN'
        } catch (e) { return (e as Error).name }
      })
      const innerOnDisk = readFileSync(inner, 'utf8')
      check(`a file inside it cannot be reached (got ${String(child)}, it still holds "${innerOnDisk}")`, child === 'NotAllowedError' && innerOnDisk === 'untouched')

      expect(fileKind).toBe('file')
      expect(read).toBe('before')
      expect(write).toBe('written')
      expect(onDisk).toBe('after')
      expect(folderKind).toBe('directory')
      expect(listing).toBe('NotAllowedError')
      expect(child).toBe('NotAllowedError')
      expect(innerOnDisk).toBe('untouched')
    } finally {
      if (app !== undefined) await closeElectronApp(app)
      if (server !== undefined) await new Promise<void>((resolve) => { server?.close(() => { resolve() }) })
      rmSync(dir, { recursive: true, force: true })
    }
  })
}, TEST_TIMEOUT_MS)
