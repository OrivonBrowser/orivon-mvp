import { afterEach, describe, expect, it, vi } from 'vitest'
import { renderChoice } from '../settings/rows.js'
import type { Control } from '../settings/model.js'
import type { SettingsState } from '../settings/state.js'

class FakeOption { value = ''; textContent = '' }

class FakeSelect {
  className = ''
  id = ''
  disabled = false
  value = ''
  dataset: Record<string, string> = {}
  options: FakeOption[] = []
  private change: (() => void) | undefined
  append (option: FakeOption): void { this.options.push(option) }
  addEventListener (_type: string, listener: () => void): void { this.change = listener }
  pick (value: string): void { this.value = value; this.change?.() }
}

afterEach(() => { vi.unstubAllGlobals() })

function setup (current: string, intercept?: NonNullable<Extract<Control, { type: 'choice' }>['intercept']>) {
  vi.stubGlobal('document', { createElement: (tag: string) => tag === 'option' ? new FakeOption() : new FakeSelect() })
  const set = vi.fn(async () => null)
  const state = {
    description: () => ({ kind: 'enum', options: ['orivon', 'none', 'custom'], labels: { orivon: 'Orivon', none: 'None', custom: 'Own' } }),
    value: () => current,
    set
  } as unknown as SettingsState
  const control: Extract<Control, { type: 'choice' }> = { type: 'choice', key: 'appearance.newTabBackground', ...(intercept === undefined ? {} : { intercept }) }
  const select = renderChoice(control, state, 'c1') as unknown as FakeSelect
  return { select, set }
}

const flush = async (): Promise<void> => { await new Promise((resolve) => { setTimeout(resolve, 0) }) }

describe('a choice with an intercept', () => {
  it('lists the options in the schema order and shows the current value', () => {
    const { select } = setup('none')
    expect(select.options.map((option) => option.value)).toEqual(['orivon', 'none', 'custom'])
    expect(select.value).toBe('none')
  })

  it('saves a pick the intercept leaves alone', async () => {
    const intercept = vi.fn(async () => false)
    const { select, set } = setup('orivon', intercept)
    select.pick('none')
    await flush()
    expect(intercept).toHaveBeenCalledWith('none', expect.anything())
    expect(set).toHaveBeenCalledWith('appearance.newTabBackground', 'none')
  })

  it('puts the earlier value back, and saves nothing itself, when the intercept dealt with the pick (a cancelled picker)', async () => {
    const intercept = vi.fn(async () => true)
    const { select, set } = setup('orivon', intercept)
    select.pick('custom')
    await flush()
    expect(select.value).toBe('orivon')
    expect(set).not.toHaveBeenCalled()
    expect(intercept).toHaveBeenCalledTimes(1)
  })

  it('puts the earlier value back when the intercept fails', async () => {
    const { select, set } = setup('none', async () => { throw new Error('the bridge is gone') })
    select.pick('custom')
    await flush()
    expect(select.value).toBe('none')
    expect(set).not.toHaveBeenCalled()
  })
})
