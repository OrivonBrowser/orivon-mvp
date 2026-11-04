// Asks the page's own WebGPU for an adapter. Main words the outcome (src/main/diagnostics/webgpu-state.ts) and is
// told only which outcome it was; the adapter's vendor and architecture stay in the page, to be shown.

export type AdapterProbe =
  | { readonly kind: 'adapter', readonly vendor: string, readonly architecture: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'no-api' }
  /** The browser did not answer in time: nothing was read, and main is told nothing. */
  | { readonly kind: 'unread' }

interface GpuApi {
  readonly requestAdapter: () => Promise<{ readonly info?: { readonly vendor?: unknown, readonly architecture?: unknown } } | null>
}

/** How long a page waits for the graphics process before it gives up: a hung one never answers. */
export const PROBE_TIMEOUT_MS = 10_000

/** What the page shows of a field the browser made up for itself: short, and text only. */
const SHOWN_LENGTH = 64

const shown = (value: unknown): string => typeof value === 'string' ? value.slice(0, SHOWN_LENGTH) : ''

async function request (gpu: GpuApi): Promise<AdapterProbe> {
  try {
    const adapter = await gpu.requestAdapter()
    if (adapter === null) return { kind: 'none' }
    return { kind: 'adapter', vendor: shown(adapter.info?.vendor), architecture: shown(adapter.info?.architecture) }
  } catch {
    return { kind: 'none' }
  }
}

/** `nav` is `navigator`: a page that is not a secure context, or whose browser has no WebGPU, has no `gpu` on it. */
export async function probeAdapter (nav: { readonly gpu?: GpuApi }, timeoutMs: number = PROBE_TIMEOUT_MS): Promise<AdapterProbe> {
  const gpu = nav.gpu
  if (gpu === undefined) return { kind: 'no-api' }
  let timer: ReturnType<typeof setTimeout> | undefined
  const late = new Promise<AdapterProbe>((resolve) => { timer = setTimeout(() => { resolve({ kind: 'unread' }) }, timeoutMs) })
  try {
    return await Promise.race([request(gpu), late])
  } finally {
    clearTimeout(timer)
  }
}

/** What a page tells main of a probe: the outcome, or nothing when it read none. */
export function adapterClaim (probe: AdapterProbe): { readonly kind: 'adapter' | 'none' | 'no-api' } | undefined {
  return probe.kind === 'unread' ? undefined : { kind: probe.kind }
}
