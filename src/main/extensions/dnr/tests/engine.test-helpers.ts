import type { DnrRequest, DnrRule } from '../types.js'

let nextRuleId = 1

/** A fresh rule id per call, so tests can add rules without tracking ids by hand. */
export function nextId(): number {
  return nextRuleId++
}

/** Fills in the DnrRequest fields most tests don't vary. */
export function makeRequest(overrides: Partial<DnrRequest> & Pick<DnrRequest, 'url'>): DnrRequest {
  return {
    method: 'get',
    resourceType: 'other',
    tabId: 1,
    frameId: 0,
    ...overrides,
  }
}

/** A minimal valid rule: block action, given id and condition. */
export function blockRule(id: number, condition: DnrRule['condition']): DnrRule {
  return { id, priority: 1, condition, action: { type: 'block' } }
}
