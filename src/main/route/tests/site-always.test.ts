import { describe, expect, it } from 'vitest'
import { alwaysState, entryToSave, planAlwaysOff, planAlwaysOn, planMove, tabKeepsSession } from '../site-always.js'
import type { AlwaysFacts, RoutePlan } from '../site-always.js'
import { profileForTab, tunnelOfPage } from '../tab-tunnel.js'
import type { TabTunnelChoice } from '../tab-tunnel.js'
import type { TunnelEntry } from '../route-state.js'
import { profileOf } from '../site-partition.js'

// "Always use for this site" saves what the tunnel panel shows as the website's own choice, and never changes what the page does.
// Each combination of the tab's choice, the website's entry and the browser-wide setting is a row of these tables.

const CHOICES: readonly (TabTunnelChoice | undefined)[] = [undefined, 'nym', 'socks5', 'direct']
const ENTRIES: readonly (TunnelEntry | undefined)[] = [undefined, 'nym', 'socks5', 'off']

/** The tunnel the page leaves by: the tab's choice over the website's entry (ADR-0101), else the entry, else what the browser does with a website that has neither. */
function leavesBy (choice: TabTunnelChoice | undefined, entry: TunnelEntry | undefined, everywhere: boolean, defaultKind: 'nym' | 'socks5' = 'nym'): string {
  return tunnelOfPage(choice, 'https://news.example', profileOf(entry), everywhere ? defaultKind : undefined) ?? 'direct'
}

/** The tab's choice and the website's entry after `plan` ran on them. */
function applied (plan: RoutePlan, choice: TabTunnelChoice | undefined, entry: TunnelEntry | undefined, everywhere: boolean): { choice: TabTunnelChoice | undefined, entry: TunnelEntry | undefined } {
  let nextChoice = choice
  let nextEntry = entry
  if (plan.tab !== undefined) nextChoice = plan.tab === null ? undefined : plan.tab
  if (plan.entry === 'forget') nextEntry = undefined
  else if (plan.entry !== undefined) nextEntry = plan.entry.choose === null ? (everywhere ? 'off' : undefined) : plan.entry.choose
  return { choice: nextChoice, entry: nextEntry }
}

describe('the entry that saving a panel makes', () => {
  it('is the tab\'s tunnel, whatever the browser does', () => {
    for (const everywhere of [false, true]) {
      expect(entryToSave('nym', everywhere)).toBe('nym')
      expect(entryToSave('socks5', everywhere)).toBe('socks5')
    }
  })

  it('is off for a direct tab only while the whole browser is on a tunnel; otherwise a direct tab says what a website already does', () => {
    expect(entryToSave('direct', true)).toBe('off')
    expect(entryToSave('direct', false)).toBeUndefined()
  })

  it('is none for a tab with no choice: the panel shows what the browser does, which is nothing to save', () => {
    expect(entryToSave(undefined, true)).toBeUndefined()
    expect(entryToSave(undefined, false)).toBeUndefined()
  })
})

describe('the switch\'s state', () => {
  it('is on exactly while the website has an entry of its own, an off entry included', () => {
    for (const choice of CHOICES) for (const entry of ENTRIES) for (const everywhere of [false, true]) {
      expect(alwaysState({ choice, entry, everywhere }).on, `${String(choice)} ${String(entry)} ${String(everywhere)}`).toBe(entry !== undefined)
    }
  })

  it('is available when it is on, or when there is a choice to save', () => {
    expect(alwaysState({ choice: undefined, entry: undefined, everywhere: true }).available, 'nothing is chosen').toBe(false)
    expect(alwaysState({ choice: undefined, entry: undefined, everywhere: false }).available).toBe(false)
    expect(alwaysState({ choice: 'direct', entry: undefined, everywhere: false }).available, 'a direct tab already says what the website does').toBe(false)
    expect(alwaysState({ choice: 'direct', entry: undefined, everywhere: true }).available).toBe(true)
    expect(alwaysState({ choice: 'nym', entry: undefined, everywhere: false }).available).toBe(true)
    expect(alwaysState({ choice: undefined, entry: 'socks5', everywhere: false }).available, 'a website with an entry can always have it taken away').toBe(true)
    expect(alwaysState({ choice: undefined, entry: 'off', everywhere: false }).available).toBe(true)
  })
})

describe('turning the switch on', () => {
  const on = (facts: AlwaysFacts): RoutePlan | undefined => planAlwaysOn(facts)

  it('makes the tab\'s choice the website\'s entry and leaves the tab alone', () => {
    expect(on({ choice: 'nym', entry: undefined, everywhere: false })).toEqual({ entry: { choose: 'nym' } })
    expect(on({ choice: 'socks5', entry: undefined, everywhere: true })).toEqual({ entry: { choose: 'socks5' } })
  })

  it('makes a direct tab an off entry while the browser is on a tunnel, by the same choice the switches make', () => {
    expect(on({ choice: 'direct', entry: undefined, everywhere: true })).toEqual({ entry: { choose: null } })
  })

  it('has nothing to do with nothing chosen, with a direct tab while the browser is not on a tunnel, or while the website already has its entry', () => {
    expect(on({ choice: undefined, entry: undefined, everywhere: true })).toBeUndefined()
    expect(on({ choice: undefined, entry: undefined, everywhere: false })).toBeUndefined()
    expect(on({ choice: 'direct', entry: undefined, everywhere: false })).toBeUndefined()
    expect(on({ choice: 'nym', entry: 'nym', everywhere: false })).toBeUndefined()
  })

  it('never changes where the page leaves by', () => {
    for (const choice of CHOICES) for (const everywhere of [false, true]) {
      const plan = on({ choice, entry: undefined, everywhere })
      if (plan === undefined) continue
      const after = applied(plan, choice, undefined, everywhere)
      expect(leavesBy(after.choice, after.entry, everywhere), `${String(choice)} ${String(everywhere)}`).toBe(leavesBy(choice, undefined, everywhere))
      expect(after.entry, 'and the website now has an entry').not.toBeUndefined()
    }
  })
})

describe('turning the switch off', () => {
  const off = (facts: AlwaysFacts): RoutePlan | undefined => planAlwaysOff(facts)

  it('hands a tab with no choice the entry\'s tunnel before the entry goes, an off entry becoming direct', () => {
    expect(off({ choice: undefined, entry: 'nym', everywhere: false })).toEqual({ tab: 'nym', entry: 'forget' })
    expect(off({ choice: undefined, entry: 'socks5', everywhere: true })).toEqual({ tab: 'socks5', entry: 'forget' })
    expect(off({ choice: undefined, entry: 'off', everywhere: true })).toEqual({ tab: 'direct', entry: 'forget' })
  })

  it('keeps a tab\'s own tunnel choice, and only lets the entry go', () => {
    expect(off({ choice: 'nym', entry: 'nym', everywhere: false })).toEqual({ entry: 'forget' })
    expect(off({ choice: 'nym', entry: 'socks5', everywhere: false }), 'the tab\'s tunnel won over the entry').toEqual({ entry: 'forget' })
    expect(off({ choice: 'direct', entry: 'off', everywhere: true })).toEqual({ entry: 'forget' })
  })

  it('gives a direct tab the entry\'s tunnel when that is what the page goes through, because a direct tab never loosens a website\'s tunnel', () => {
    expect(off({ choice: 'direct', entry: 'nym', everywhere: true })).toEqual({ tab: 'nym', entry: 'forget' })
    expect(off({ choice: 'direct', entry: 'socks5', everywhere: false })).toEqual({ tab: 'socks5', entry: 'forget' })
  })

  it('has nothing to do while the website has no entry', () => {
    for (const choice of CHOICES) for (const everywhere of [false, true]) expect(off({ choice, entry: undefined, everywhere })).toBeUndefined()
  })

  it('never changes where the page leaves by, for every combination', () => {
    for (const choice of CHOICES) for (const everywhere of [false, true]) for (const kind of ['nym', 'socks5'] as const) for (const entry of ENTRIES) {
      const plan = off({ choice, entry, everywhere })
      if (plan === undefined) continue
      const after = applied(plan, choice, entry, everywhere)
      expect(after.entry, 'the entry is gone').toBeUndefined()
      expect(leavesBy(after.choice, after.entry, everywhere, kind), `${String(choice)} ${String(entry)} ${String(everywhere)} ${kind}`).toBe(leavesBy(choice, entry, everywhere, kind))
    }
  })
})

describe('moving a row', () => {
  it('sets the tab\'s choice alone while the website has no entry', () => {
    expect(planMove({ choice: undefined, entry: undefined, everywhere: false }, 'nym')).toEqual({ tab: 'nym' })
    expect(planMove({ choice: 'nym', entry: undefined, everywhere: false }, null), 'the lit row turned off while the browser is off a tunnel').toEqual({ tab: null })
    expect(planMove({ choice: undefined, entry: undefined, everywhere: true }, null), 'and while it is on one').toEqual({ tab: 'direct' })
  })

  it('changes the entry with the tab while Always is on, so the row really moves', () => {
    expect(planMove({ choice: 'nym', entry: 'nym', everywhere: false }, 'socks5')).toEqual({ tab: 'socks5', entry: { choose: 'socks5' } })
    expect(planMove({ choice: undefined, entry: 'nym', everywhere: false }, 'socks5')).toEqual({ tab: 'socks5', entry: { choose: 'socks5' } })
  })

  it('takes both away when the lit row is turned off with the browser off a tunnel, and makes both direct with it on one', () => {
    expect(planMove({ choice: 'nym', entry: 'nym', everywhere: false }, null)).toEqual({ tab: null, entry: { choose: null } })
    expect(planMove({ choice: undefined, entry: 'nym', everywhere: true }, null)).toEqual({ tab: 'direct', entry: { choose: null } })
  })

  it('leaves the page by the tunnel asked for, whatever the tab and the entry were', () => {
    for (const choice of CHOICES) for (const entry of ENTRIES) for (const everywhere of [false, true]) for (const kind of [null, 'nym', 'socks5'] as const) {
      const plan = planMove({ choice, entry, everywhere }, kind)
      const after = applied(plan, choice, entry, everywhere)
      const wanted = kind ?? 'direct'
      expect(leavesBy(after.choice, after.entry, everywhere), `${String(choice)} ${String(entry)} ${String(everywhere)} ${String(kind)}`).toBe(wanted)
    }
  })
})

describe('the session a tab holds once the website\'s entry is gone', () => {
  it('is the one the entry put the page in exactly when the tab\'s choice names the same profile', () => {
    for (const choice of [undefined, 'nym', 'socks5', 'direct'] as const) {
      for (const entry of [undefined, 'nym', 'socks5', 'off'] as const) {
        const was = profileOf(entry)
        expect(tabKeepsSession(choice, entry), `tab ${String(choice)}, entry ${String(entry)}`).toBe(was !== undefined && profileForTab(choice, 'https://news.example', undefined) === was)
      }
    }
  })
})
