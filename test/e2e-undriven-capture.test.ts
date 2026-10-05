// The memory saver keeps a page awake while Chromium counts it as captured. Playwright's own connection raises that
// count on every page, so the other specs switch the rule off; this one launches the shell with nothing driving it
// and reads the count through the main process's own inspector, so the rule is known not to hold every page awake.
import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HERMETIC_RESOLVER } from './support/smoke-helpers.mjs'

const electronPath = createRequire(import.meta.url)('electron') as string

const READ = `JSON.stringify(process.mainModule.require('electron').webContents.getAllWebContents().map((wc) => ({ url: wc.getURL(), captured: wc.isBeingCaptured() })))`

async function inspectorUrl (child: ChildProcess): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let seen = ''
    const timer = setTimeout(() => { reject(new Error(`no inspector address in: ${seen.slice(-400)}`)) }, 30_000)
    child.stderr?.on('data', (chunk: Buffer) => {
      seen += String(chunk)
      const found = /ws:\/\/127\.0\.0\.1:\d+\/[\w-]+/.exec(seen)
      if (found !== null) { clearTimeout(timer); resolve(found[0]) }
    })
    child.once('exit', () => { clearTimeout(timer); reject(new Error('the shell exited before the inspector opened')) })
  })
}

async function evaluate (url: string, expression: string): Promise<string> {
  const socket = new WebSocket(url)
  await new Promise<void>((resolve, reject) => { socket.addEventListener('open', () => { resolve() }); socket.addEventListener('error', () => { reject(new Error('inspector refused')) }) })
  try {
    return await new Promise<string>((resolve, reject) => {
      socket.addEventListener('message', (event) => {
        const reply = JSON.parse(String(event.data)) as { id?: number, result?: { result?: { value?: string }, exceptionDetails?: unknown } }
        if (reply.id !== 1) return
        if (reply.result?.exceptionDetails !== undefined) reject(new Error(JSON.stringify(reply.result.exceptionDetails)))
        else resolve(reply.result?.result?.value ?? '')
      })
      socket.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, returnByValue: true } }))
    })
  } finally {
    socket.close()
  }
}

it('reports no page of an undriven shell as captured', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'orivon-undriven-'))
  const env = { ...process.env, PULSE_SERVER: 'unix:/nonexistent', ORIVON_WINDOW_NO_FOCUS: '1', ORIVON_ETH_LIGHT_CLIENT: 'off', ORIVON_INTRO: 'off' } as Record<string, string | undefined>
  delete env['ELECTRON_RUN_AS_NODE']
  const child = spawn(electronPath, ['.', `--user-data-dir=${dir}`, '--inspect=0', '--no-sandbox', '--alsa-output-device=null', HERMETIC_RESOLVER], { env, stdio: ['ignore', 'ignore', 'pipe'] })
  try {
    const url = await inspectorUrl(child)
    let pages: Array<{ url: string, captured: boolean }> = []
    for (let attempt = 0; attempt < 60 && !pages.some((page) => page.url.endsWith('/renderer/index.html')); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 500))
      try { pages = JSON.parse(await evaluate(url, READ)) as typeof pages } catch { pages = [] }
    }
    expect(pages.some((page) => page.url.endsWith('/renderer/index.html'))).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 1500))
    pages = JSON.parse(await evaluate(url, READ)) as typeof pages
    expect(pages.length).toBeGreaterThan(1)
    expect(pages.filter((page) => page.captured)).toEqual([])
  } finally {
    child.kill('SIGKILL')
    await new Promise((resolve) => setTimeout(resolve, 500))
    await rm(dir, { recursive: true, force: true })
  }
}, 120_000)
