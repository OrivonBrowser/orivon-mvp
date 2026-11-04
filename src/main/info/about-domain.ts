// What the About page may ask of main: the version table, the graphics report, whether WebGPU works,
// what this version changed, and to have either copied. The text to copy is built here from main's own
// facts, so a page cannot put anything of its own on the clipboard.
import type { InternalDomain } from '../pages/internal-ipc.js'
import type { RunningRelease } from './running-release.js'
import { gpuDevicesOf, gpuFeaturesOf } from '../diagnostics/gpu-reading.js'
import { adapterReading, webGpuState } from '../diagnostics/webgpu-state.js'
import { aboutRows, aboutText, deviceRows, featureRows, rawReport, webGpuTone } from './about-info.js'
import type { AboutFacts } from './about-info.js'

export interface GpuReading {
  readonly status: unknown
  /** `getGPUInfo('basic')`, or undefined when it rejected. */
  readonly info: unknown
  /** `process.platform`. */
  readonly platform: string
  /** The desktop session (`XDG_SESSION_TYPE`), or '' when the system names none. */
  readonly session: string
  /** The Ozone platform the browser runs on, or '' when there is none to name. */
  readonly ozone: string
}

/** The Graphics tab asks for the report and for WebGPU's state together: one reading younger than this serves both. */
const SHARED_READING_MS = 2_000

export interface AboutDomainDeps {
  readonly facts: () => AboutFacts
  readonly gpu: () => Promise<GpuReading>
  readonly copy: (text: string) => void
  /** The version running and what it changed. */
  readonly release: () => RunningRelease
}

export function infoDomain (deps: AboutDomainDeps): InternalDomain {
  let latest: { readonly at: number, readonly reading: Promise<GpuReading> } | undefined
  /** The graphics reading of the last couple of seconds, or a new one; a failed one is not kept. */
  const sharedReading = async (): Promise<GpuReading> => {
    const now = Date.now()
    if (latest === undefined || now - latest.at > SHARED_READING_MS) {
      const taken = { at: now, reading: deps.gpu() }
      taken.reading.catch(() => { if (latest === taken) latest = undefined })
      latest = taken
    }
    return await latest.reading
  }
  return {
    pages: ['about'],
    handle: async (command) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as { type?: unknown, what?: unknown, adapter?: unknown }
      switch (request.type) {
        case 'version':
          return { rows: aboutRows(deps.facts()) }
        case 'whatsnew': {
          const { version, notes } = deps.release()
          return { version, sections: notes?.sections ?? [] }
        }
        case 'gpu': {
          try {
            const { status, info } = await sharedReading()
            return {
              ok: true,
              features: featureRows(status),
              devices: deviceRows(info),
              devicesKnown: info !== undefined,
              raw: rawReport(status, info)
            }
          } catch {
            return { ok: false }
          }
        }
        case 'webgpu': {
          try {
            const { status, info, platform, session, ozone } = await sharedReading()
            const features = gpuFeaturesOf(status)
            const answer = webGpuState({ platform, session, ozone, features, devices: gpuDevicesOf(info), adapter: adapterReading(request.adapter) })
            return { ok: true, ...answer, tone: webGpuTone(answer, features['webgpu']) }
          } catch {
            return { ok: false }
          }
        }
        case 'copy': {
          if (request.what === 'version') {
            deps.copy(aboutText(aboutRows(deps.facts())))
            return { ok: true }
          }
          if (request.what === 'gpu') {
            try {
              const { status, info } = await deps.gpu()
              deps.copy(rawReport(status, info))
              return { ok: true }
            } catch {
              return { ok: false }
            }
          }
          return undefined
        }
        default:
          return undefined
      }
    }
  }
}
