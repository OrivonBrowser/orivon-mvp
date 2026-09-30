// Draws the two tabs of the About page from its state. Nothing here calls the
// bridge: the buttons call back into the state, which owns the requests.
import { h } from '../shared/dom.js'
import type { AboutRow, AboutState, DeviceRow, FeatureRow, GpuReport } from './state.js'

function skeletonCard (rows: number): HTMLElement {
  return h('div', { className: 'card', role: 'status', ariaLabel: 'Loading' },
    ...Array.from({ length: rows }, (_, index) => {
      const value = h('span', { className: 'skeleton value-skeleton' })
      value.style.width = index % 2 === 0 ? '55%' : '35%'
      return h('div', { className: 'row' }, h('span', { className: 'skeleton label-skeleton' }), value)
    }))
}

function versionCard (rows: readonly AboutRow[]): HTMLElement {
  return h('div', { className: 'card' }, ...rows.map((row) => h('div', { className: 'row' },
    h('span', { className: 'row-label', textContent: row.label }),
    h('span', { className: row.mono ? 'value mono' : 'value', textContent: row.value }))))
}

function featureCard (features: readonly FeatureRow[]): HTMLElement {
  return h('div', { className: 'card' }, ...features.map((feature) => h('div', { className: 'row' },
    h('span', { className: 'row-label', textContent: feature.label }),
    h('span', { className: feature.tone === 'neutral' ? 'badge' : `badge ${feature.tone}`, textContent: feature.text }))))
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

export function gpuBody (state: AboutState, retry: () => void, copyRaw: (button: HTMLButtonElement) => void): HTMLElement {
  const { gpu } = state
  if (gpu === null || gpu.state === 'loading') {
    return h('div', { className: 'stack' }, h('h2', { className: 'group-label', textContent: 'Feature status' }), skeletonCard(6))
  }
  const failed = gpu.state === 'error' || (gpu.value.features.length === 0 && gpu.value.devices.length === 0)
  if (failed) {
    return h('div', { className: 'banner error', role: 'alert' },
      'Graphics information is not available. ',
      h('button', { className: 'link-btn', type: 'button', textContent: 'Try again', onclick: retry }))
  }
  return h('div', { className: 'stack' },
    h('h2', { className: 'group-label', textContent: 'Feature status' }),
    featureCard(gpu.value.features),
    h('h2', { className: 'group-label', textContent: 'Graphics device' }),
    deviceCard(gpu.value.devices, gpu.value.devicesKnown),
    rawReport(gpu.value, copyRaw))
}
