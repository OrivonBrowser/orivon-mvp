// Asks this page's own WebGPU for an adapter. Main words the outcome (src/main/diagnostics/webgpu-state.ts) and
// is told only which outcome it was; the adapter's vendor and architecture stay in this page, to be shown.

export type AdapterProbe =
  | { readonly kind: 'adapter', readonly vendor: string, readonly architecture: string }
  | { readonly kind: 'none' }
  | { readonly kind: 'no-api' }

interface GpuApi {
  readonly requestAdapter: () => Promise<{ readonly info?: { readonly vendor?: unknown, readonly architecture?: unknown } } | null>
}

/** What the page shows of a field the browser made up for itself: short, and text only. */
const SHOWN_LENGTH = 64

const shown = (value: unknown): string => typeof value === 'string' ? value.slice(0, SHOWN_LENGTH) : ''

/** `nav` is `navigator`: a page that is not a secure context, or whose browser has no WebGPU, has no `gpu` on it. */
export async function probeAdapter (nav: { readonly gpu?: GpuApi }): Promise<AdapterProbe> {
  const gpu = nav.gpu
  if (gpu === undefined) return { kind: 'no-api' }
  try {
    const adapter = await gpu.requestAdapter()
    if (adapter === null) return { kind: 'none' }
    return { kind: 'adapter', vendor: shown(adapter.info?.vendor), architecture: shown(adapter.info?.architecture) }
  } catch {
    return { kind: 'none' }
  }
}
