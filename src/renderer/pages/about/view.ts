// Draws the three tabs of the About page from its state. Nothing here calls the
// bridge: the buttons call back into the state, which owns the requests.
import { h } from '../shared/dom.js'
import { inlineSegments } from './inline-markdown.js'
import type { AboutRow, AboutState, DeviceRow, FeatureRow, GpuReport, Loadable, NotesSection, Tone, WebGpuReport } from './state.js'

function skeletonCard (rows: number): HTMLElement {
  return h('div', { className: 'card', role: 'status', ariaLabel: 'Loading' },
    ...Array.from({ length: rows }, (_, index) => {
      const value = h('span', { className: 'skeleton value-skeleton' })
      value.style.width = index % 2 === 0 ? '55%' : '35%'
      return h('div', { className: 'row' }, h('span', { className: 'skeleton label-skeleton' }), value)
    }))
}

/** A value longer than this goes under its label, where it has the card's whole width to wrap in. */
const LONG_VALUE = 48

function versionCard (rows: readonly AboutRow[]): HTMLElement {
  return h('div', { className: 'card' }, ...rows.map((row) => h('div', { className: row.mono || row.value.length > LONG_VALUE ? 'row long' : 'row' },
    h('span', { className: 'row-label', textContent: row.label }),
    h('span', { className: row.mono ? 'value mono' : 'value', textContent: row.value }))))
}

const badgeClass = (tone: Tone): string => tone === 'neutral' ? 'badge' : `badge ${tone}`

function featureCard (features: readonly FeatureRow[]): HTMLElement {
  return h('div', { className: 'card' }, ...features.map((feature) => h('div', { className: 'row' },
    h('span', { className: 'row-label', textContent: feature.label }),
    h('span', { className: badgeClass(feature.tone), textContent: feature.text }))))
}

function deviceCard (devices: readonly DeviceRow[], known: boolean): HTMLElement {
  if (devices.length === 0) {
    return h('div', { className: 'card' }, h('div', { className: 'row' },
      h('span', { className: 'row-label', textContent: 'Graphics device' }),
      h('span', { className: 'value', textContent: known ? 'None reported' : 'Not available on this computer' })))
  }
  return h('div', { className: 'card' }, ...devices.flatMap((device) => [
    h('div', { className: 'row' }, h('span', { className: 'row-label', textContent: 'Vendor' }), h('span', { className: 'value', textContent: device.vendor })),
    h('div', { className: 'row' }, h('span', { className: 'row-label', textContent: 'Device' }), h('span', { className: 'value', textContent: device.device })),
    h('div', { className: 'row' }, h('span', { className: 'row-label', textContent: 'Driver' }), h('span', { className: 'value', textContent: device.driver })),
    h('div', { className: 'row' },
      h('span', { className: 'row-label', textContent: 'In use' }),
      h('span', { className: device.active ? 'badge ok' : 'badge', textContent: device.active ? 'Active' : 'Not active' }))
  ]))
}

const WEBGPU_BADGE_TEXT: Readonly<Record<WebGpuReport['state'], string>> = {
  available: 'Works',
  unavailable: 'Not available',
  unknown: 'Not known'
}

const plainRow = (label: string, value: string): HTMLElement => h('div', { className: 'row' },
  h('span', { className: 'row-label', textContent: label }),
  h('span', { className: 'value', textContent: value }))

const statusRow = (text: string, tone: Tone): HTMLElement => h('div', { className: 'row' },
  h('span', { className: 'row-label', textContent: 'Status' }),
  h('span', { className: badgeClass(tone), textContent: text }))

/** Whether WebGPU works here, and when it does not, the reason in a sentence. */
function webGpuCard (webGpu: Loadable<WebGpuReport> | null, retry: () => void): HTMLElement {
  if (webGpu === null || webGpu.state === 'loading') return skeletonCard(1)
  if (webGpu.state === 'error') {
    return h('div', { className: 'card' }, statusRow(WEBGPU_BADGE_TEXT.unknown, 'neutral'),
      h('div', { className: 'row long', role: 'alert' }, h('span', { className: 'value' },
        'WebGPU could not be checked. ',
        h('button', { className: 'link-btn', type: 'button', textContent: 'Try again', onclick: retry }))))
  }
  const report = webGpu.value
  const status = statusRow(WEBGPU_BADGE_TEXT[report.state], report.tone)
  if (report.state !== 'available') {
    return h('div', { className: 'card' }, status, h('div', { className: 'row long' }, h('span', { className: 'value', textContent: report.sentence })))
  }
  return h('div', { className: 'card' }, status,
    plainRow('Adapter vendor', report.vendor === '' ? 'Not reported' : report.vendor),
    plainRow('Adapter architecture', report.architecture === '' ? 'Not reported' : report.architecture))
}

function rawReport (report: GpuReport, copy: (button: HTMLButtonElement) => void): HTMLElement {
  const button = h('button', { className: 'link-btn', type: 'button', textContent: 'Copy', onclick: () => { copy(button) } })
  return h('details', { className: 'raw' },
    h('summary', { textContent: 'Raw report' }),
    h('div', { className: 'raw-head' }, button),
    h('pre', { className: 'raw-body', tabIndex: 0, textContent: report.raw }))
}

export function versionBody (state: AboutState): HTMLElement {
  const { version } = state
  if (version.state === 'loading') return skeletonCard(6)
  if (version.state === 'error') return h('div', { className: 'banner error', role: 'alert', textContent: 'Version information is not available.' })
  return versionCard(version.value)
}

/** The feature table, the device and the raw report: the part of the Graphics tab that comes from `getGPUInfo`. */
function graphicsReport (gpu: AboutState['gpu'], retry: () => void, copyRaw: (button: HTMLButtonElement) => void): HTMLElement[] {
  if (gpu === null || gpu.state === 'loading') return [h('h2', { className: 'group-label', textContent: 'Feature status' }), skeletonCard(6)]
  const failed = gpu.state === 'error' || (gpu.value.features.length === 0 && gpu.value.devices.length === 0)
  if (failed) {
    return [h('div', { className: 'banner error', role: 'alert' },
      'Graphics information is not available. ',
      h('button', { className: 'link-btn', type: 'button', textContent: 'Try again', onclick: retry }))]
  }
  return [
    h('h2', { className: 'group-label', textContent: 'Feature status' }),
    featureCard(gpu.value.features),
    h('h2', { className: 'group-label', textContent: 'Graphics device' }),
    deviceCard(gpu.value.devices, gpu.value.devicesKnown),
    rawReport(gpu.value, copyRaw)
  ]
}

/** `retry` asks for both parts again: WebGPU's answer does not depend on the report, so either may show without the other. */
export function gpuBody (state: AboutState, retry: () => void, copyRaw: (button: HTMLButtonElement) => void): HTMLElement {
  return h('div', { className: 'stack' },
    h('h2', { className: 'group-label', textContent: 'WebGPU' }),
    webGpuCard(state.webGpu, retry),
    ...graphicsReport(state.gpu, retry, copyRaw))
}

function noteItem (item: string): HTMLElement {
  return h('li', { className: 'note' }, ...inlineSegments(item).map((segment) =>
    segment.kind === 'text' ? segment.text : h(segment.kind === 'bold' ? 'strong' : 'code', { textContent: segment.text })))
}

function noteSection (section: NotesSection): HTMLElement {
  return h('section', { className: 'notes' },
    h('h2', { className: 'group-label', textContent: section.heading }),
    h('ul', { className: 'card note-list' }, ...section.items.map(noteItem)))
}

export function whatsNewBody (state: AboutState): HTMLElement {
  const { whatsNew } = state
  if (whatsNew === null || whatsNew.state === 'loading') return skeletonCard(4)
  if (whatsNew.state === 'error') return h('div', { className: 'banner error', role: 'alert', textContent: 'What changed in this version is not available.' })
  const { version, sections } = whatsNew.value
  if (sections.length === 0) {
    return h('div', { className: 'banner', role: 'status', textContent: `This build of Orivon (${version}) has no list of changes.` })
  }
  return h('div', { className: 'stack' },
    h('p', { className: 'notes-lead', textContent: `What changed in version ${version}` }),
    ...sections.map(noteSection))
}
