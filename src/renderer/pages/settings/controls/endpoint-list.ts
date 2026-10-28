// The list of Ethereum server addresses a setting holds, one a line, drawn with its keys hidden: the same control as the sites
// list (`host-list.ts`) with the model of an address (`endpoint-list-model.ts`).
import type { SettingKey } from '../../../../main/settings/schema.js'
import type { ServerKind } from '../../../../protocols/verifier-host/light-client/server-address.js'
import type { Control } from '../model.js'
import { hostListControl } from './host-list.js'
import { addEndpoint, joinEndpoints, PROBLEM_SAVE, removeEndpoint, shownEndpoint, splitEndpoints } from './endpoint-list-model.js'

export interface EndpointListOptions {
  readonly kind: ServerKind
  /** The most addresses the setting holds; main's check says the same. */
  readonly max: number
  readonly placeholder: string
  readonly empty: string
  /** The field's accessible name. */
  readonly label: string
  /** The field's placeholder once the list holds `max` addresses. */
  readonly full: string
}

/** A row's control for a setting that holds Ethereum server addresses, one a line. */
export function endpointListControl (key: SettingKey, options: EndpointListOptions): Extract<Control, { type: 'custom' }> {
  const { kind, max } = options
  return hostListControl(key, {
    placeholder: options.placeholder,
    empty: options.empty,
    label: options.label,
    model: {
      max,
      fieldMaxLength: 2048,
      fieldLabel: options.label,
      fullPlaceholder: options.full,
      saveProblem: PROBLEM_SAVE,
      split: splitEndpoints,
      join: joinEndpoints,
      add: (endpoints, text) => {
        const outcome = addEndpoint(endpoints, text, kind, max)
        if (outcome.kind === 'added') return { kind: 'added', items: outcome.endpoints }
        if (outcome.kind === 'duplicate') return outcome
        return { kind: outcome.kind, problem: outcome.kind === 'full' ? options.full : outcome.problem }
      },
      remove: removeEndpoint,
      show: shownEndpoint
    }
  })
}
