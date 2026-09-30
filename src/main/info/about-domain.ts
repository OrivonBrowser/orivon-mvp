// What the About page may ask of main: the version table, the graphics report,
// and to have either copied. The text to copy is built here from main's own
// facts, so a page cannot put anything of its own on the clipboard.
import type { InternalDomain } from '../pages/internal-ipc.js'
import { aboutRows, aboutText, deviceRows, featureRows, rawReport } from './about-info.js'
import type { AboutFacts } from './about-info.js'

export interface GpuReading {
  readonly status: unknown
  /** `getGPUInfo('basic')`, or undefined when it rejected. */
  readonly info: unknown
}

export interface AboutDomainDeps {
  readonly facts: () => AboutFacts
  readonly gpu: () => Promise<GpuReading>
  readonly copy: (text: string) => void
}

export function infoDomain (deps: AboutDomainDeps): InternalDomain {
  return {
    pages: ['about'],
    handle: async (command) => {
      const request = (typeof command === 'object' && command !== null ? command : {}) as { type?: unknown, what?: unknown }
      switch (request.type) {
        case 'version':
          return { rows: aboutRows(deps.facts()) }
        case 'gpu': {
          try {
            const { status, info } = await deps.gpu()
            const statusRecord = typeof status === 'object' && status !== null ? status as Record<string, unknown> : {}
            return {
              ok: true,
              features: featureRows(statusRecord),
              devices: deviceRows(info),
              devicesKnown: info !== undefined,
              raw: rawReport(status, info)
            }
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
