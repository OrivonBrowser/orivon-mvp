import { describe, expect, it, vi } from 'vitest'
import { createDisplayPolicy, type DisplayPolicyDeps } from '../display-policy.js'

const TAB = { id: 1 } as never

function setup (overrides: Partial<DisplayPolicyDeps> = {}): { deps: DisplayPolicyDeps, policy: ReturnType<typeof createDisplayPolicy> } {
  const deps: DisplayPolicyDeps = {
    isApp: (origin) => origin === 'https://app.example',
    blockedByDefault: () => false,
    storedBlock: () => false,
    noteBlocked: vi.fn(),
    appGrants: { held: vi.fn(() => false), request: vi.fn(async () => await Promise.resolve(true)) },
    ...overrides
  }
  return { deps, policy: createDisplayPolicy(deps) }
}

describe('the display policy', () => {
  it('shows a website the picker with no grant', async () => {
    const { policy, deps } = setup()
    expect(policy.mayAsk('https://a.example')).toBe(true)
    expect(await policy.decide(TAB, 'https://a.example')).toBe(true)
    expect(deps.noteBlocked).not.toHaveBeenCalled()
  })

  it('refuses a website when the default is block, and tells the chip', async () => {
    const { policy, deps } = setup({ blockedByDefault: () => true })
    expect(policy.mayAsk('https://a.example')).toBe(false)
    expect(await policy.decide(TAB, 'https://a.example')).toBe(false)
    expect(deps.noteBlocked).toHaveBeenCalledWith(TAB, 'https://a.example')
  })

  it('refuses a website whose own answer is block, and no other', async () => {
    const { policy, deps } = setup({ storedBlock: (origin) => origin === 'https://blocked.example' })
    expect(await policy.decide(TAB, 'https://blocked.example')).toBe(false)
    expect(deps.noteBlocked).toHaveBeenCalledOnce()
    expect(policy.mayAsk('https://a.example')).toBe(true)
  })

  it('asks the app grant for a registered app, and never the website setting', async () => {
    const { policy, deps } = setup({ blockedByDefault: () => true, appGrants: { held: vi.fn(() => true), request: vi.fn(async () => await Promise.resolve(false)) } })
    expect(await policy.decide(TAB, 'https://app.example')).toBe(false)
    expect(deps.appGrants.request).toHaveBeenCalledWith(TAB, 'https://app.example', 'media.screen')
    expect(policy.mayAsk('https://app.example')).toBe(true)
    expect(deps.noteBlocked).not.toHaveBeenCalled()
  })

  it('answers the synchronous check for an app only from a grant already held', () => {
    expect(setup().policy.mayAsk('https://app.example')).toBe(false)
  })
})
