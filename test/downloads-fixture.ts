// What the downloads end-to-end files share: a server with files that arrive whole, slowly, never finish or
// break half way, the launch with a chosen downloads folder, and the stand-ins for the operating system's
// file manager so nothing opens on the screen.
import { createServer, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ElectronApplication, Page } from 'playwright'
import { expect } from 'vitest'
import { launchElectron } from './launch-electron.mjs'
import { clickAddressBarRetrying } from './e2e-helpers.js'
import { findChrome, findViewShowing, HERMETIC_RESOLVER, waitFor, waitForTab } from './smoke-helpers.mjs'

export const FILE_SIZE = 200 * 1024
export const CHUNK = 64 * 1024
export const SLOW_CHUNKS = 20

export function bytesOf (size: number): Buffer {
  return Buffer.from(Array.from({ length: size }, (_, index) => index % 251))
}

const ATTACHMENT = (name: string): Record<string, string> => ({ 'content-type': 'application/octet-stream', 'content-disposition': `attachment; filename="${name}"` })

export interface DownloadServer {
  readonly origin: string
  close: () => Promise<void>
}

/** Every address answers with a link page, except the files. `/slow.bin` sends 64 KB every 200 ms, `/stall.bin` sends 64 KB and waits, `/broken.bin` drops its connection half way. */
export async function startServer (): Promise<DownloadServer> {
  const open = new Set<ServerResponse>()
  const server: Server = createServer((request, response) => {
    const url = request.url ?? '/'
    if (url === '/file.bin') {
      response.writeHead(200, { ...ATTACHMENT('file.bin'), 'content-length': String(FILE_SIZE) })
      response.end(bytesOf(FILE_SIZE))
    } else if (url === '/setup.exe') {
      response.writeHead(200, { ...ATTACHMENT('setup.exe'), 'content-length': '4096' })
      response.end(bytesOf(4096))
    } else if (url === '/slow.bin' || url === '/stall.bin') {
      const chunks = url === '/slow.bin' ? SLOW_CHUNKS : 16
      response.writeHead(200, { ...ATTACHMENT(url.slice(1)), 'content-length': String(CHUNK * chunks) })
      open.add(response)
      response.on('close', () => { open.delete(response) })
      let sent = 0
      const send = (): void => {
        if (response.destroyed) return
        response.write(Buffer.alloc(CHUNK, 7))
        sent += 1
        if (url === '/stall.bin' && sent === 1) return
        if (sent === chunks) response.end()
        else setTimeout(send, 200)
      }
      send()
    } else if (url === '/broken.bin') {
      response.writeHead(200, { ...ATTACHMENT('broken.bin'), 'content-length': '100000' })
      response.write(Buffer.alloc(10_000, 1), () => { setTimeout(() => { response.destroy() }, 100) })
    } else {
      response.writeHead(200, { 'content-type': 'text/html' })
      response.end(`<!doctype html><title>Files</title>
        <a id="file" href="/file.bin">file</a> <a id="exe" href="/setup.exe">exe</a> <a id="slow" href="/slow.bin">slow</a>
        <a id="stall" href="/stall.bin">stall</a> <a id="broken" href="/broken.bin">broken</a>`)
    }
  })
  await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', resolve) })
  return {
    origin: `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`,
    close: async () => {
      for (const response of open) response.destroy()
      await new Promise<void>((resolve) => { server.close(() => { resolve() }); server.closeAllConnections() })
    }
  }
}

export async function scratchDir (prefix = 'orivon-downloads-'): Promise<string> {
  return await mkdtemp(join(tmpdir(), prefix))
}

export async function removeDir (dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true })
}

export interface Launched {
  readonly app: ElectronApplication
  readonly chrome: Page
}

/** Launches with `downloads.folder` in the profile, or without it: then the caller must point the system folder away from the real one. */
export async function launchDownloads (options: { folder?: string, args?: string[], reuseProfile?: string } = {}): Promise<Launched> {
  const { folder, args = [], reuseProfile } = options
  const app = await launchElectron({
    appPath: '.',
    args: [HERMETIC_RESOLVER, ...args],
    ...(reuseProfile === undefined ? {} : { reuseProfile }),
    ...(folder === undefined || reuseProfile !== undefined ? {} : { seedProfile: async (dir: string) => { await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { 'downloads.folder': folder } })) } })
  })
  expect(await waitFor(() => { try { findChrome(app); return true } catch { return false } })).toBe(true)
  return { app, chrome: findChrome(app) }
}

/** The operating system's file manager is replaced by recorders: nothing may open on the screen. */
export async function stubSystem (app: ElectronApplication, systemDownloads?: string): Promise<void> {
  await app.evaluate(({ shell, app: electron }, dir) => {
    const calls: string[] = []
    ;(globalThis as unknown as { __shellCalls: string[] }).__shellCalls = calls
    shell.openPath = (async (path: string) => { calls.push(`open ${path}`); return '' }) as typeof shell.openPath
    shell.showItemInFolder = ((path: string) => { calls.push(`show ${path}`) }) as typeof shell.showItemInFolder
    shell.trashItem = (async (path: string) => { calls.push(`trash ${path}`) }) as typeof shell.trashItem
    if (dir !== undefined) electron.setPath('downloads', dir)
  }, systemDownloads)
}

export async function shellCalls (app: ElectronApplication): Promise<string[]> {
  return await app.evaluate(() => [...(globalThis as unknown as { __shellCalls: string[] }).__shellCalls])
}

export async function visitFiles (app: ElectronApplication, chrome: Page, origin: string): Promise<Page> {
  await clickAddressBarRetrying(chrome, `${origin}/`)
  expect((await waitForTab(chrome, { address: `${origin}/` })).ok).toBe(true)
  expect(await waitFor(() => findViewShowing(app, chrome, `${origin}/`) !== undefined)).toBe(true)
  return findViewShowing(app, chrome, `${origin}/`) as Page
}

export async function openInternalPage (app: ElectronApplication, chrome: Page, page: string, path?: string): Promise<Page> {
  await chrome.evaluate(([name, where]) => { (window as unknown as { orivonShell: { openInternal: (page: string, path?: string) => void } }).orivonShell.openInternal(name as string, where as string | undefined) }, [page, path])
  expect(await waitFor(() => app.windows().some((w) => w.url().startsWith(`orivon://${page}`)))).toBe(true)
  const found = app.windows().find((w) => w.url().startsWith(`orivon://${page}`)) as Page
  await found.waitForSelector('.page, .content')
  return found
}

export const row = (page: Page, fileName: string) => page.locator('.download', { hasText: fileName })

/** Follows a link of the fixture page from inside it, so it works while another tab is in front: a tab that is not shown cannot be clicked. */
export async function clickLink (files: Page, selector: string): Promise<void> {
  await files.evaluate((target) => { (document.querySelector(target) as HTMLElement).click() }, selector)
}
