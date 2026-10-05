// The words of the four questions an offered update raises (ADR-0055): the verified offer, the
// notice for one that is not, the Trust & Force confirmation and a failed download. Pure, like
// ./grant-prompt-render.ts: ./update-outcomes-prompt.ts shows them. The address leads every text,
// as it does in every question of this family; the name the manifest claims is a claim on its own line.

import { reasonText } from '../../trust/app-update-trust.js'
import type { UpdateOffer } from '../install/app-updates.js'
import { formatOriginForDisplay } from './grant-prompt-origin.js'

export interface UpdateContent {
  readonly title: string
  readonly message: string
  readonly detail: string
  readonly warning: boolean
}

function versionLine (offer: UpdateOffer): string {
  return offer.fromVersion === undefined ? `Version ${offer.toVersion}.` : `Version ${offer.fromVersion} to ${offer.toVersion}.`
}

function claimLine (offer: UpdateOffer): string {
  return `Claims to be "${offer.claimedName}".`
}

export function describeVerifiedUpdate (offer: UpdateOffer): UpdateContent {
  const origin = formatOriginForDisplay(offer.origin)
  const level = offer.level === undefined ? [] : [`The Web3 Score provider rates this exact version Level ${String(offer.level)}.`]
  return {
    title: origin,
    message: `${origin} has updated the app to a new version. Do you want to switch to the new version?`,
    detail: [claimLine(offer), versionLine(offer), ...level, 'Your grants and data stay with the app.'].join('\n'),
    warning: false
  }
}

export function describeUnverifiedUpdate (offer: UpdateOffer): UpdateContent {
  const origin = formatOriginForDisplay(offer.origin)
  const what = offer.reasons.includes('not-newer') ? 'now points at another version of the app' : 'has updated the app to a new version'
  return {
    title: origin,
    message: `${origin} ${what}. Its Web3 Score has not been verified yet. To switch, open the key icon and choose Trust & Force update.`,
    detail: [claimLine(offer), versionLine(offer), ...offer.reasons.map((reason) => reasonText(reason, offer.newDomain)), 'The version you have keeps running until you switch.'].join('\n'),
    warning: false
  }
}

export function describeForceUpdate (offer: UpdateOffer, held: readonly string[]): UpdateContent {
  const origin = formatOriginForDisplay(offer.origin)
  const carried = held.length === 0
    ? ['It holds no grants today. Its data carries over to the new version.']
    : ['These grants and its data carry over to the new version, which can use them as soon as it loads:', ...held.map((line) => `- ${line}`)]
  return {
    title: origin,
    message: `Switch ${origin} to a version nobody has verified?`,
    detail: [claimLine(offer), versionLine(offer), ...offer.reasons.map((reason) => reasonText(reason, offer.newDomain)), ...carried].join('\n'),
    warning: true
  }
}

export function describeFailedUpdate (offer: UpdateOffer, reason: string): UpdateContent {
  const origin = formatOriginForDisplay(offer.origin)
  return {
    title: origin,
    message: `Could not switch ${origin} to the new version: ${reason}. The version you have keeps running, and the update is still offered.`,
    detail: versionLine(offer),
    warning: false
  }
}
