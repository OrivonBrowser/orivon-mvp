import type { SiteUpdate } from '../../main/permissions/site-info.js'

// The update the key offers for an installed app whose name moved (ADR-0055): the versions, why a
// version is not verified, and one button. A verified version is taken with Update; any other only
// through Trust & Force update, which main confirms before it does anything. Never innerHTML: every
// string here is composed in main or comes from a manifest.

export interface UpdateCardCallbacks {
  readonly onApply: (cid: string) => void
}

export function updateHeading (update: SiteUpdate): string {
  return update.fromVersion === undefined ? `Version ${update.toVersion} is available` : `Version ${update.toVersion} is available (you have ${update.fromVersion})`
}

export function updateButtonLabel (update: SiteUpdate): string {
  return update.verified ? 'Update' : 'Trust & Force update'
}

/** `failure` is why the last try did not install, shown under the card. */
export function renderUpdateCard (update: SiteUpdate, failure: string | null, callbacks: UpdateCardCallbacks): HTMLElement {
  const card = document.createElement('section')
  card.className = `update-card${update.verified ? '' : ' unverified'}`

  const heading = document.createElement('p')
  heading.className = 'update-heading'
  heading.textContent = updateHeading(update)
  card.append(heading)

  const verdict = document.createElement('p')
  verdict.className = 'update-verdict'
  verdict.textContent = update.verified
    ? `Verified: a Web3 Score provider rates this exact version${update.level === undefined ? '' : ` Level ${String(update.level)}`}.`
    : 'Not verified. Its Web3 Score could not be confirmed:'
  card.append(verdict)

  if (!update.verified) {
    const reasons = document.createElement('ul')
    reasons.className = 'update-reasons'
    for (const reason of update.reasons) {
      const item = document.createElement('li')
      item.textContent = reason
      reasons.append(item)
    }
    card.append(reasons)
  }

  const apply = document.createElement('button')
  apply.type = 'button'
  apply.className = update.verified ? 'btn-primary' : 'btn-secondary update-force'
  apply.textContent = updateButtonLabel(update)
  apply.addEventListener('click', () => { callbacks.onApply(update.toCid) })
  card.append(apply)

  if (failure !== null) {
    const failed = document.createElement('p')
    failed.className = 'update-failure'
    failed.textContent = failure
    card.append(failed)
  }
  return card
}
