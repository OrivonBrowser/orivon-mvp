import { beforeEach, describe, expect, it, vi } from 'vitest'
import { env, fakeTabs, page } from './fakes.js'

const { showToast, sleepTabWhy } = vi.hoisted(() => ({ showToast: vi.fn(), sleepTabWhy: vi.fn() }))
vi.mock('../../page-tools/toast.js', () => ({ showToast }))
vi.mock('../sleep-tab.js', () => ({ sleepTabWhy }))
vi.mock('../../shell/tab-partition.js', () => ({ appTabViews: new WeakSet() }))
vi.mock('../../overlays/tab-slots.js', () => ({ hasAsk: () => false }))

const { neighbourOf, sleepBackgroundTab, sleepFrontTab, toastFor } = await import('../sleep-command.js')

beforeEach(() => {
  showToast.mockReset()
  sleepTabWhy.mockReset().mockResolvedValue({ ok: true })
})

function window (over: Parameters<typeof page>[1] = {}) {
  const fake = fakeTabs({ a: page(), b: page('https://b.example/', over), c: page('https://c.example/') })
  fake.setActive('b')
  const activate = vi.spyOn(fake.tabs, 'activateTab')
  return { ...fake, activate, shell: { tabs: fake.tabs } as never }
}

describe('toastFor', () => {
  it('words each reason the way the person would hear it', () => {
    expect(toastFor('sound')).toBe('sleepSound')
    expect(toastFor('unsaved')).toBe('sleepUnsaved')
    expect(toastFor('pinned')).toBe('sleepPinned')
    expect(toastFor('ask')).toBe('sleepAsk')
    expect(toastFor('media')).toBe('sleepMedia')
    expect(toastFor('kept')).toBe('sleepKept')
    expect(toastFor('devtools')).toBe('sleepOther')
    expect(toastFor('app')).toBe('sleepOther')
  })

  it('says nothing for a tab that is gone', () => {
    expect(toastFor('gone')).toBeNull()
  })
})

describe('neighbourOf', () => {
  it('is the nearest tab, the one before on a tie, and never the tab it is joined to', () => {
    expect(neighbourOf(['a', 'b', 'c'], 'b', null)).toBe('a')
    expect(neighbourOf(['a', 'b', 'c'], 'a', null)).toBe('b')
    expect(neighbourOf(['a', 'b', 'c'], 'c', null)).toBe('b')
    expect(neighbourOf(['a', 'b', 'c'], 'b', 'a')).toBe('c')
    expect(neighbourOf(['a', 'b'], 'a', 'b')).toBeUndefined()
    expect(neighbourOf(['a'], 'a', null)).toBeUndefined()
    expect(neighbourOf(['a'], 'z', null)).toBeUndefined()
  })

  it('passes over a tab a collapsed group hides, unless none other is left', () => {
    expect(neighbourOf(['a', 'x', 'y', 'c'], 'c', null, (id) => id === 'x' || id === 'y')).toBe('a')
    expect(neighbourOf(['x', 'c'], 'c', null, (id) => id === 'x')).toBe('x')
  })
})

describe('sleepBackgroundTab', () => {
  it('puts the tab to sleep without a word', async () => {
    const { shell } = window()
    await sleepBackgroundTab(shell, 'a', env())
    expect(sleepTabWhy).toHaveBeenCalledWith(expect.anything(), 'a', expect.anything())
    expect(showToast).not.toHaveBeenCalled()
  })

  it('says why a tab stays awake', async () => {
    sleepTabWhy.mockResolvedValue({ ok: false, why: 'sound' })
    const { shell } = window()
    await sleepBackgroundTab(shell, 'a', env())
    expect(showToast).toHaveBeenCalledWith(shell, 'sleepSound')
  })
})

describe('sleepFrontTab', () => {
  it('moves to the neighbour and then puts the tab to sleep', async () => {
    const { shell, activate } = window()
    await sleepFrontTab(shell, 'b', env())
    expect(activate).toHaveBeenCalledWith('a')
    expect(sleepTabWhy).toHaveBeenCalledWith(expect.anything(), 'b', expect.anything())
    expect(showToast).not.toHaveBeenCalled()
  })

  it('leaves the person where they are when something keeps the tab awake, and says what', async () => {
    const { shell, activate } = window({ audible: true })
    await sleepFrontTab(shell, 'b', env())
    expect(activate).not.toHaveBeenCalled()
    expect(sleepTabWhy).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(shell, 'sleepSound')
  })

  it('asks the page about unsaved input before leaving it', async () => {
    const { shell, activate } = window()
    await sleepFrontTab(shell, 'b', env({ unsaved: async () => true }))
    expect(activate).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(shell, 'sleepUnsaved')
  })

  it('has nowhere to go from the only tab', async () => {
    const fake = fakeTabs({ b: page() })
    fake.setActive('b')
    const activate = vi.spyOn(fake.tabs, 'activateTab')
    await sleepFrontTab({ tabs: fake.tabs } as never, 'b', env())
    expect(activate).not.toHaveBeenCalled()
    expect(showToast).toHaveBeenCalledWith(expect.anything(), 'sleepOther')
  })

  it('goes back to the tab when it was refused in the moment between', async () => {
    sleepTabWhy.mockResolvedValue({ ok: false, why: 'ask' })
    const { shell, activate } = window()
    await sleepFrontTab(shell, 'b', env())
    expect(activate.mock.calls).toEqual([['a'], ['b']])
    expect(showToast).toHaveBeenCalledWith(shell, 'sleepAsk')
  })
})
