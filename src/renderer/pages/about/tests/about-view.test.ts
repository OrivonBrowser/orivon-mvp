import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AboutState, GpuReport, Loadable, WebGpuReport } from '../state.js'
import { gpuBody } from '../view.js'

interface Fake {
  tag: string
  className: string
  textContent: string
  onclick?: () => void
  style: Record<string, string>
  children: Array<Fake | { text: string }>
  append: (...nodes: Array<Fake | { text: string }>) => void
}

function fake (tag: string): Fake {
  const element: Fake = { tag, className: '', textContent: '', style: {}, children: [], append: (...nodes) => { element.children.push(...nodes) } }
  return element
}

const walk = (node: Fake | { text: string }): Array<Fake | { text: string }> => 'text' in node ? [node] : [node, ...node.children.flatMap(walk)]
const elements = (root: Fake): Fake[] => walk(root).filter((node): node is Fake => 'tag' in node)
const textOf = (node: Fake): string => node.textContent + node.children.map((child) => 'text' in child ? child.text : textOf(child)).join('')
const labels = (root: Fake): string[] => elements(root).filter((node) => node.className === 'group-label').map(textOf)
const buttons = (root: Fake): Fake[] => elements(root).filter((node) => node.tag === 'button' && textOf(node) === 'Try again')

beforeEach(() => {
  vi.stubGlobal('document', { createElement: fake, createTextNode: (text: string) => ({ text }) })
})
afterEach(() => { vi.unstubAllGlobals() })

const REPORT: GpuReport = { features: [{ key: 'webgl', label: 'WebGL', text: 'Hardware accelerated', tone: 'ok' }], devices: [], devicesKnown: true, raw: '{}' }
const OFF: WebGpuReport = { state: 'unavailable', sentence: 'Chromium has turned WebGPU off on this computer.', tone: 'neutral', vendor: '', architecture: '' }
const WORKS: WebGpuReport = { state: 'available', sentence: 'WebGPU works on this computer.', tone: 'ok', vendor: 'intel', architecture: '' }

function body (gpu: Loadable<GpuReport> | null, webGpu: Loadable<WebGpuReport> | null, retry: () => void = () => {}): Fake {
  return gpuBody({ gpu, webGpu } as AboutState, retry, () => {}) as unknown as Fake
}

describe('the Graphics tab', () => {
  it('starts with the WebGPU section, before the feature table and the device', () => {
    expect(labels(body({ state: 'ready', value: REPORT }, { state: 'ready', value: OFF })))
      .toEqual(['WebGPU', 'Feature status', 'Graphics device'])
  })

  it('shows the WebGPU section on its own when the graphics report failed, with the report\'s retry beside it', () => {
    const retry = vi.fn()
    const tab = body({ state: 'error' }, { state: 'ready', value: OFF }, retry)
    expect(labels(tab)).toEqual(['WebGPU'])
    expect(elements(tab).some((node) => node.className === 'badge' && textOf(node) === 'Not available')).toBe(true)
    expect(elements(tab).some((node) => node.className === 'banner error')).toBe(true)
    buttons(tab)[0]?.onclick?.()
    expect(retry).toHaveBeenCalledOnce()
  })

  it('shows the graphics report on its own when WebGPU could not be checked, and offers to try again', () => {
    const retry = vi.fn()
    const tab = body({ state: 'ready', value: REPORT }, { state: 'error' }, retry)
    expect(labels(tab)).toEqual(['WebGPU', 'Feature status', 'Graphics device'])
    expect(elements(tab).some((node) => node.className === 'badge' && textOf(node) === 'Not known')).toBe(true)
    expect(buttons(tab)).toHaveLength(1)
    buttons(tab)[0]?.onclick?.()
    expect(retry).toHaveBeenCalledOnce()
  })

  it('colours the WebGPU badge by the tone main chose', () => {
    const badge = (report: WebGpuReport): string | undefined => elements(body({ state: 'ready', value: REPORT }, { state: 'ready', value: report })).find((node) => textOf(node) === 'Not available' || textOf(node) === 'Works')?.className
    expect(badge(OFF)).toBe('badge')
    expect(badge({ ...OFF, tone: 'warn' })).toBe('badge warn')
    expect(badge(WORKS)).toBe('badge ok')
  })

  it('shows skeletons while either part loads, and the WebGPU heading all the same', () => {
    const tab = body({ state: 'loading' }, { state: 'loading' })
    expect(labels(tab)).toEqual(['WebGPU', 'Feature status'])
    expect(elements(tab).filter((node) => node.className === 'card')).toHaveLength(2)
  })
})
