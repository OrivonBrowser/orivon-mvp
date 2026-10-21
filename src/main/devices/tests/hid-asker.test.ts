import { describe, expect, it, vi } from 'vitest'
import { createHidAsker, NO_ANSWER, type HidAskerDeps } from '../hid-asker.js'
import type { HidDeviceInfo } from '../hid-policy.js'
import type { QuestionResult, QuestionSpec } from '../../shell/question/question-spec.js'

const APP = 'https://wallet.example'
const NANO: HidDeviceInfo = { vendorId: 0x2c97, productId: 0x4011, serialNumber: '0001', name: 'Nano X' }
const SECOND: HidDeviceInfo = { ...NANO, serialNumber: '0002' }

interface Tab { readonly id: string, alive: boolean }

function setup (answer: number | 'hold' = 0, overrides: Partial<HidAskerDeps<Tab>> = {}) {
  const tab: Tab = { id: 'tab', alive: true }
  const releases: Array<(result: QuestionResult) => void> = []
  const asked: QuestionSpec[] = []
  const deps: HidAskerDeps<Tab> = {
    tabOf: () => tab,
    appName: async () => 'Wallet',
    isAlive: (candidate) => candidate.alive,
    question: async (_tab, spec) => {
      asked.push(spec)
      if (answer === 'hold') return await new Promise<QuestionResult>((resolve) => { releases.push(resolve) })
      return { response: answer, checkboxChecked: false }
    },
    approve: vi.fn(() => true),
    decline: vi.fn(),
    announce: vi.fn(),
    ...overrides
  }
  return { asker: createHidAsker(deps), deps, asked, releases, tab }
}

const settle = async (): Promise<void> => { await new Promise((resolve) => { setImmediate(resolve) }) }

describe('createHidAsker', () => {
  it('names the device, its USB ids and the app, with Allow first and Not now as the way out', async () => {
    const { asker, asked } = setup()
    asker.ask(APP, NANO)
    await settle()
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ kind: 'consent', message: 'Connect Nano X (USB 2c97:4011) to Wallet?', origin: APP, buttons: ['Allow', 'Not now'], cancelId: 1 })
    expect(asked[0]?.guarded).toEqual([0])
    expect(asked[0]?.detail).toContain('0001')
  })

  it('on Allow remembers the device, then tells the origin it has appeared', async () => {
    const { asker, deps } = setup(0)
    asker.ask(APP, NANO)
    await settle()
    expect(deps.approve).toHaveBeenCalledWith(APP, NANO)
    expect(deps.announce).toHaveBeenCalledWith(APP, [NANO])
    expect(deps.decline).not.toHaveBeenCalled()
  })

  it('on Not now suppresses the device and announces nothing', async () => {
    const { asker, deps } = setup(1)
    asker.ask(APP, NANO)
    await settle()
    expect(deps.decline).toHaveBeenCalledWith(APP, NANO)
    expect(deps.approve).not.toHaveBeenCalled()
    expect(deps.announce).not.toHaveBeenCalled()
  })

  it('announces nothing when the approval could not be kept', async () => {
    const { asker, deps } = setup(0, { approve: vi.fn(() => false) })
    asker.ask(APP, NANO)
    await settle()
    expect(deps.announce).not.toHaveBeenCalled()
  })

  it('takes a question that ended with no answer as no decision: the device is asked about again', async () => {
    const { asker, deps, asked } = setup(NO_ANSWER)
    asker.ask(APP, NANO)
    await settle()
    expect(deps.decline).not.toHaveBeenCalled()
    expect(deps.approve).not.toHaveBeenCalled()
    asker.ask(APP, NANO)
    await settle()
    expect(asked).toHaveLength(2)
  })

  it('keeps one open question for one origin and device, and a second one for another serial', async () => {
    const { asker, asked } = setup('hold')
    asker.ask(APP, NANO)
    asker.ask(APP, NANO)
    asker.ask(APP, SECOND)
    await settle()
    expect(asked).toHaveLength(2)
  })

  it('may ask again about a device once its question is answered', async () => {
    const { asker, asked } = setup(1)
    asker.ask(APP, NANO)
    await settle()
    asker.ask(APP, NANO)
    await settle()
    expect(asked).toHaveLength(2)
  })

  it('asks nothing when no tab of the origin is open', async () => {
    const { asker, asked, deps } = setup(0, { tabOf: () => undefined })
    asker.ask(APP, NANO)
    await settle()
    expect(asked).toEqual([])
    expect(deps.decline).not.toHaveBeenCalled()
  })

  it('does not hold it against the device when the tab went away while the question was open', async () => {
    const { asker, deps, tab, releases } = setup('hold')
    asker.ask(APP, NANO)
    await settle()
    tab.alive = false
    releases[0]?.({ response: 1, checkboxChecked: false })
    await settle()
    expect(deps.decline).not.toHaveBeenCalled()
    expect(deps.approve).not.toHaveBeenCalled()
  })

  it('falls back to the origin when the app has no name, and survives a question that throws', async () => {
    const quiet = vi.spyOn(console, 'error').mockImplementation(() => {})
    const named = setup(0, { appName: async () => undefined })
    named.asker.ask(APP, NANO)
    await settle()
    expect(named.asked[0]?.message).toBe(`Connect Nano X (USB 2c97:4011) to ${APP}?`)
    const broken = setup(0, { question: async () => { throw new Error('no panel') } })
    broken.asker.ask(APP, NANO)
    await settle()
    expect(broken.deps.approve).not.toHaveBeenCalled()
    quiet.mockRestore()
  })
})
