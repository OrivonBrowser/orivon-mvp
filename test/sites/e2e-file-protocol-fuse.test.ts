// The Electron binary this suite launches has its file-protocol fuse off: src/main/local-files/file-fuse.ts
// reads it so, as @electron/fuses does, and a `file:` page in a throwaway session gets no more reach than a
// web page does (a sibling image taints a canvas, a sibling fetch is refused). The session is made here and
// has its 404 for file: taken off, so what is measured is Chromium's loader. Run `npm run install:electron`
// when this fails on a checkout whose binary was never flipped.
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getCurrentFuseWire, FuseV1Options } from '@electron/fuses'
import { afterAll, expect, it } from 'vitest'
import { fuseFilePath, readFileProtocolFuse } from '../../src/main/local-files/file-fuse.js'
import { closeElectronApp } from '../support/e2e-helpers.js'
import { assertNoElectronSurvivors } from '../support/launch-electron.mjs'
import { launchShell } from '../support/qa-helpers.js'

afterAll(async () => {
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const TEST_TIMEOUT_MS = 60_000

/** A 1x1 PNG. */
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')

it('runs on a binary whose file-protocol fuse is off, and a file: page then reaches no more than a web page', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'orivon-fuse-spec-'))
  const other = mkdtempSync(join(tmpdir(), 'orivon-fuse-spec-other-'))
  const { app } = await launchShell()
  try {
    const executable = await app.evaluate(() => process.execPath)
    expect(await readFileProtocolFuse(fuseFilePath(executable))).toBe('off')
    expect((await getCurrentFuseWire(executable))[FuseV1Options.GrantFileProtocolExtraPrivileges]).toBe(48)

    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'sibling.png'), PNG)
    writeFileSync(join(dir, 'sibling.txt'), 'sibling')
    writeFileSync(join(dir, 'page.html'), '<!doctype html><title>local</title>')
    writeFileSync(join(other, 'foreign.png'), PNG)

    const outcomes = await app.evaluate(async ({ BrowserWindow }, { page, siblingDir, otherDir }) => {
      const win = new BrowserWindow({ show: false, webPreferences: { partition: 'file-fuse-spec', sandbox: true, contextIsolation: true } })
      try {
        // Every session answers file: with a 404 at creation; this one measures Chromium's own loader.
        win.webContents.session.protocol.unhandle('file')
        await win.loadFile(page)
        const canvas = (src: string): string => `new Promise((resolve) => { const i = new Image(); i.onload = () => { try { const c = document.createElement('canvas'); c.width = c.height = 1; const x = c.getContext('2d'); x.drawImage(i, 0, 0); x.getImageData(0, 0, 1, 1); resolve('read') } catch (e) { resolve(e.name) } }; i.onerror = () => resolve('image error'); i.src = ${JSON.stringify(src)} })`
        const run = async (script: string): Promise<string> => await win.webContents.executeJavaScript(script)
        return {
          sibling: await run(canvas(`file://${siblingDir}/sibling.png`)),
          otherFolder: await run(canvas(`file://${otherDir}/foreign.png`)),
          fetchSibling: await run(`fetch(${JSON.stringify(`file://${siblingDir}/sibling.txt`)}).then(() => 'fetched', (e) => 'rejected ' + e.name)`)
        }
      } finally {
        win.destroy()
      }
    }, { page: join(dir, 'page.html'), siblingDir: dir, otherDir: other })

    expect(outcomes.sibling).toBe('SecurityError')
    expect(outcomes.otherFolder).toBe('SecurityError')
    expect(outcomes.fetchSibling).toMatch(/^rejected /)
  } finally {
    await closeElectronApp(app)
    rmSync(dir, { recursive: true, force: true })
    rmSync(other, { recursive: true, force: true })
  }
}, TEST_TIMEOUT_MS)
