// What a first visit needs from the shell, published where it is built and read where a visit begins. The manifest
// hint listener and the first-request hold start before the shell and before each other, so a reader treats
// `undefined` as routine and reads at the moment of use. Each is published by the one place that builds it:
// a second first visit built elsewhere could ask the same person twice.
import type { FirstVisit } from '../install/first-visit.js'
import type { TabSetup } from './tab-screens.js'

let setup: TabSetup | undefined
let visit: FirstVisit | undefined

export function publishTabSetup (value: TabSetup): void {
  setup = value
}

export function publishFirstVisit (value: FirstVisit): void {
  visit = value
}

export const tabSetupNow = (): TabSetup | undefined => setup
export const firstVisitNow = (): FirstVisit | undefined => visit
