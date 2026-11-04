// The WebGPU-on-X11 setting in a running shell: what a profile with it on gets (the switches, and an adapter where a
// graphics card is behind the display), what a profile with it off gets, and the guard that turns it off after a bad
// run. The setting is the profile's own `settings.json`, because Playwright's launcher replaces a feature list given
// on the command line, so a spec cannot hand Orivon the switches. Docs: docs/planning/webgpu-plan.md, step 3.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ElectronApplication } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { assertNoElectronSurvivors, closeElectron } from '../support/launch-electron.mjs'
import { html, launchShell, QA_TEST_TIMEOUT_MS, startServer, visitWithoutPage } from '../support/qa-helpers.js'
import type { FixtureServer } from '../support/qa-helpers.js'
import { waitFor } from '../support/smoke-helpers.mjs'

const KEY = 'graphics.webgpuOnX11'
const GUARD_FILE = 'x11-vulkan.json'
const LINUX = process.platform === 'linux'
const DOUBLED = [2, 4, 6, 8]

/** A graphics card behind the display: a CI runner has none, and Chromium offers no adapter on the processor. */
const HAS_RENDER_NODE = LINUX && existsSync('/dev/dri') && readdirSync('/dev/dri').some((name) => name.startsWith('renderD'))

let server: FixtureServer

beforeAll(async () => {
  server = await startServer((_request, response) => { html(response, '<!doctype html><title>gpu</title><p>gpu</p>') })
})

afterAll(async () => {
  await server.close()
  expect(await assertNoElectronSurvivors()).toEqual([])
})

const PAGE_PROBE = `(async () => {
  const out = { hasGpu: 'gpu' in navigator, adapter: null, compute: null }
  if (!navigator.gpu) return out
  const adapter = await navigator.gpu.requestAdapter()
  if (adapter === null) return out
  out.adapter = { vendor: adapter.info.vendor, fallback: adapter.info.isFallbackAdapter === true }
  const device = await adapter.requestDevice()
  const input = device.createBuffer({ size: 16, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC | GPUBufferUsage.COPY_DST })
  device.queue.writeBuffer(input, 0, new Float32Array([1, 2, 3, 4]))
  const read = device.createBuffer({ size: 16, usage: GPUBufferUsage.MAP_READ | GPUBufferUsage.COPY_DST })
  const module = device.createShaderModule({ code: '@group(0) @binding(0) var<storage, read_write> v: array<f32>; @compute @workgroup_size(4) fn main(@builtin(global_invocation_id) id: vec3u) { v[id.x] = v[id.x] * 2.0; }' })
  const pipeline = device.createComputePipeline({ layout: 'auto', compute: { module, entryPoint: 'main' } })
  const bind = device.createBindGroup({ layout: pipeline.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: input } }] })
  const encoder = device.createCommandEncoder()
  const pass = encoder.beginComputePass()
  pass.setPipeline(pipeline); pass.setBindGroup(0, bind); pass.dispatchWorkgroups(1); pass.end()
  encoder.copyBufferToBuffer(input, 0, read, 0, 16)
  device.queue.submit([encoder.finish()])
  await read.mapAsync(GPUMapMode.READ)
  out.compute = Array.from(new Float32Array(read.getMappedRange()))
  return out
})()`

interface PageSeen {
  readonly hasGpu: boolean
  readonly adapter: { readonly vendor: string, readonly fallback: boolean } | null
  readonly compute: readonly number[] | null
}

interface Profile {
  /** The setting as `settings.json` holds it; undefined leaves the profile as a new one. */
  readonly setting?: boolean
  /** What the guard's file holds when the run starts. */
  readonly guard?: { readonly pendingWindow: boolean, readonly revert: { readonly at: string, readonly why: string } | null }
  /** Environment variables for the run. */
  readonly env?: Record<string, string>
}

const seed = (profile: Profile) => async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true })
  if (profile.setting !== undefined) await writeFile(join(dir, 'settings.json'), JSON.stringify({ version: 1, values: { [KEY]: profile.setting } }))
  if (profile.guard !== undefined) await writeFile(join(dir, GUARD_FILE), JSON.stringify(profile.guard))
}

async function launched (profile: Profile): Promise<{ app: ElectronApplication, dir: string }> {
  const { app, chrome } = await launchShell({ seedProfile: seed(profile), ...(profile.env === undefined ? {} : { env: profile.env }) })
  try {
    await visitWithoutPage(app, chrome, `${server.origin}/`)
    return { app, dir: await app.evaluate(({ app: electron }) => electron.getPath('userData')) }
  } catch (error) {
    await closeElectron(app)
    throw error
  }
}

const switchesOf = async (app: ElectronApplication): Promise<{ angle: string, features: string[] }> => await app.evaluate(({ app: electron }) => ({
  angle: electron.commandLine.getSwitchValue('use-angle'),
  features: electron.commandLine.getSwitchValue('enable-features').split(',').filter((name) => name !== '')
}))

async function pageOf (app: ElectronApplication): Promise<PageSeen> {
  return await app.evaluate(async ({ webContents }, { target, script }) => {
    const contents = webContents.getAllWebContents().find((candidate) => candidate.getURL().startsWith(target))
    if (contents === undefined) throw new Error('no tab on the fixture page')
    return await contents.executeJavaScript(script) as unknown
  }, { target: server.origin, script: PAGE_PROBE }) as PageSeen
}

const guardOf = (dir: string): { pendingWindow: boolean, revert: { at: string, why: string } | null } | undefined => {
  try { return JSON.parse(readFileSync(join(dir, GUARD_FILE), 'utf8')) as { pendingWindow: boolean, revert: { at: string, why: string } | null } } catch { return undefined }
}

const settingOf = (dir: string): unknown => {
  try { return (JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')) as { values?: Record<string, unknown> }).values?.[KEY] } catch { return undefined }
}

describe('the setting on', () => {
  it('sets the switches on an X11 session and nowhere else, and gives a page an adapter where a card is behind the display', async () => {
    const { app, dir } = await launched({ setting: true })
    try {
      const { angle, features } = await switchesOf(app)
      if (LINUX) {
        expect(angle).toBe('vulkan')
        expect(features).toEqual(expect.arrayContaining(['Vulkan', 'VulkanFromANGLE']))
        // The run marks itself until the first window shows, and clears the mark when it has.
        expect(await waitFor(() => guardOf(dir)?.pendingWindow === false)).toBe(true)
        const page = await pageOf(app)
        console.log(`WEBGPU-X11-ON ${JSON.stringify({ page, renderNode: HAS_RENDER_NODE })}`)
        if (HAS_RENDER_NODE) {
          expect(page.adapter).not.toBeNull()
          expect(page.adapter?.fallback).toBe(false)
          expect(page.compute).toEqual(DOUBLED)
        }
      } else {
        expect(angle).toBe('')
        expect(features).not.toContain('VulkanFromANGLE')
        expect(guardOf(dir)).toBeUndefined()
      }
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)
})

describe('the setting off', () => {
  it('sets no switch, and a page on an X11 session gets no adapter', async () => {
    const { app, dir } = await launched({})
    try {
      const { angle, features } = await switchesOf(app)
      expect(angle).toBe('')
      expect(features).not.toContain('VulkanFromANGLE')
      expect(features).not.toContain('Vulkan')
      if (LINUX) {
        const page = await pageOf(app)
        expect(page.adapter).toBeNull()
      }
      expect(guardOf(dir)?.revert ?? null).toBeNull()
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)
})

describe.skipIf(!LINUX)('the guard', () => {
  it('turns the setting off, and keeps why and when, when the graphics process crashes', async () => {
    const { app, dir } = await launched({ setting: true })
    try {
      expect(await waitFor(() => guardOf(dir)?.pendingWindow === false)).toBe(true)
      const pid = await app.evaluate(({ app: electron }) => electron.getAppMetrics().find((metric) => metric.type === 'GPU')?.pid)
      expect(pid, 'the graphics process runs').toBeTypeOf('number')
      const killedAt = Date.now()
      process.kill(pid as number, 'SIGSEGV')
      expect(await waitFor(() => guardOf(dir)?.revert?.why === 'gpu-crash', 30_000)).toBe(true)
      const revert = guardOf(dir)?.revert as { at: string, why: string }
      expect(Date.parse(revert.at)).toBeGreaterThanOrEqual(killedAt - 1000)
      // The saved setting reads off: the store drops a setting at its default from the file.
      expect(await waitFor(() => settingOf(dir) !== true)).toBe(true)
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)

  it('turns the setting off when the switches are set and no Vulkan driver can be loaded, so pages are drawn on the processor', async () => {
    const { app, dir } = await launched({ setting: true, env: { VK_ICD_FILENAMES: '/nonexistent/no-vulkan-driver.json' } })
    try {
      expect(await waitFor(() => guardOf(dir)?.pendingWindow === false)).toBe(true)
      // A graphics process that cannot start may also end with an abnormal exit first; both turn the setting off.
      expect(await waitFor(() => guardOf(dir)?.revert !== null && guardOf(dir)?.revert !== undefined, 60_000)).toBe(true)
      expect(['gpu-software', 'gpu-crash']).toContain(guardOf(dir)?.revert?.why)
      expect(await waitFor(() => settingOf(dir) !== true)).toBe(true)
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)

  it('reverts at the next start when a run set the switches and never showed its first window', async () => {
    const { app, dir } = await launched({ setting: true, guard: { pendingWindow: true, revert: null } })
    try {
      const { angle, features } = await switchesOf(app)
      expect(angle).toBe('')
      expect(features).not.toContain('VulkanFromANGLE')
      expect(guardOf(dir)?.revert?.why).toBe('no-window')
      expect(guardOf(dir)?.pendingWindow).toBe(false)
      expect(settingOf(dir)).not.toBe(true)
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)

  it('forgets a revert when the setting is on again and the run starts clean', async () => {
    const { app, dir } = await launched({ setting: true, guard: { pendingWindow: false, revert: { at: '2026-11-03T08:00:00.000Z', why: 'gpu-crash' } } })
    try {
      const { angle } = await switchesOf(app)
      expect(angle).toBe('vulkan')
      expect(await waitFor(() => guardOf(dir)?.pendingWindow === false && guardOf(dir)?.revert === null)).toBe(true)
    } finally {
      await closeElectron(app)
    }
  }, QA_TEST_TIMEOUT_MS)
})
