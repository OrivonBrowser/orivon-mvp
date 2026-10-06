// Whether telemetry may run in this process at all, and where it keeps its state and sends it. Pure
// except for the two test-build reads below, which exist only where the developer flag is compiled in
// (an ordinary build carries neither the variables' names nor the code that reads them).
import { join } from 'node:path'

declare const __ORIVON_DEV_GRANT_ENABLED__: boolean | undefined
const SEAM_ENABLED = typeof __ORIVON_DEV_GRANT_ENABLED__ !== 'undefined' && __ORIVON_DEV_GRANT_ENABLED__ === true

/** The address reports go to. An ordinary build sends nowhere else. */
export const TELEMETRY_BASE_URL = 'https://telemetry.orivonstack.com/v1/'

export type OffReason = 'development' | 'env' | 'private'

export interface ModeInputs {
  /** `npm run dev`'s developer mode, or electron-vite's dev server. */
  readonly development: boolean
  /** `ORIVON_TELEMETRY=off`: set by every test and smoke launch. */
  readonly disabledByEnv: boolean
  readonly privateSession: boolean
}

/** Why telemetry does not run in this process, or undefined when it may. Off means it never starts: nothing measured, no machine identifier read, nothing sent. */
export function telemetryOffReason (inputs: ModeInputs): OffReason | undefined {
  if (inputs.privateSession) return 'private'
  if (inputs.development) return 'development'
  if (inputs.disabledByEnv) return 'env'
  return undefined
}

export function modeInputsFromEnv (env: NodeJS.ProcessEnv, developerMode: boolean, privateSession: boolean): ModeInputs {
  const rendererDevServer = env['ELECTRON_RENDERER_URL'] !== undefined && env['ELECTRON_RENDERER_URL'] !== ''
  return {
    development: developerMode || rendererDevServer,
    disabledByEnv: env['ORIVON_TELEMETRY'] === 'off',
    privateSession
  }
}

export interface TestOverrides {
  readonly home: string | undefined
  readonly url: string | undefined
  /** Milliseconds between the checkpoint and send ticks, and no random wait before a send: a test cannot wait a month. */
  readonly tickMs: number | undefined
}

/** What a test build was told through the environment; an ordinary build reads nothing and returns none. */
export function testOverrides (env: NodeJS.ProcessEnv = process.env): TestOverrides {
  if (!SEAM_ENABLED) return { home: undefined, url: undefined, tickMs: undefined }
  const tick = Number(env['ORIVON_TELEMETRY_TICK_MS'])
  return { home: env['ORIVON_TELEMETRY_HOME'], url: env['ORIVON_TELEMETRY_URL'], tickMs: Number.isFinite(tick) && tick >= 50 ? tick : undefined }
}

/** Whether this build carries the test-only overrides. */
export const IS_TEST_BUILD = SEAM_ENABLED

export interface HomeInputs {
  readonly testBuild: boolean
  readonly overrideHome: string | undefined
  readonly development: boolean
  readonly userData: string
  readonly appData: string
}

/**
 * The folder holding consent.json and, rarely, a fallback ID: shared by every profile and by every run
 * of this program for one operating-system user. A test build or a development run never reaches the
 * real one: they use their own temporary profile.
 */
export function telemetryHome (inputs: HomeInputs): string {
  if (inputs.testBuild) return inputs.overrideHome !== undefined && inputs.overrideHome !== '' ? inputs.overrideHome : join(inputs.userData, 'telemetry-home')
  if (inputs.development) return join(inputs.userData, 'telemetry-home')
  return join(inputs.appData, 'orivon-telemetry')
}

function isLoopbackHttp (value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]')
  } catch {
    return false
  }
}

/** The base address ending in a slash: the real one, or in a test build a loopback address it was given. */
export function ingestBaseUrl (testBuild: boolean, overrideUrl: string | undefined): string {
  if (!testBuild || overrideUrl === undefined || !isLoopbackHttp(overrideUrl)) return TELEMETRY_BASE_URL
  return overrideUrl.endsWith('/') ? overrideUrl : `${overrideUrl}/`
}

export type Endpoint = 'usage' | 'sites' | 'erase'

export function endpointUrl (base: string, endpoint: Endpoint): string {
  return `${base}${endpoint}`
}
