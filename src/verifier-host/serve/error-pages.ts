// The pages a `.eth` tab shows instead of content, one per kind of failure.
// Each lead says only what that kind of failure establishes, and the detail
// line beneath it says the rest. Static text only: each is served with
// `default-src 'none'`, so nothing on it can run or load.

import type { ResolutionFailure } from '../../resolution/records.js'

export type ErrorPage = ResolutionFailure

export const ERROR_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'"

const PAGES: Readonly<Record<ErrorPage, { status: number, title: string, lead: string }>> = {
  'not-synced': {
    status: 503,
    title: 'Cannot verify this name yet',
    lead: "Orivon's Ethereum light client is not following the chain yet, so it cannot prove what this name points to. Nothing unverified is shown in the meantime."
  },
  unverifiable: {
    status: 502,
    title: 'Cannot verify this site',
    lead: 'Something Orivon received for this site could not be verified against what the Ethereum chain says the name points to, so nothing from it is shown. Someone may be tampering with it.'
  },
  unavailable: {
    status: 502,
    title: 'Cannot check this site right now',
    lead: 'Orivon could not get what it needs to check this site, so nothing from it is shown.'
  },
  'not-found': {
    status: 404,
    title: 'Nothing here',
    lead: 'This name points to no content, or its content has no file at this address.'
  },
  'invalid-name': {
    status: 400,
    title: 'Not a name Orivon can look up',
    lead: 'This name is not in the normalised form ENS uses, or is written in a form this version of Orivon refuses. Nothing was looked up.'
  },
  unsupported: {
    status: 501,
    title: 'This kind of site is not supported',
    lead: 'This name points to content this version of Orivon cannot load and verify.'
  }
}

function escapeHtml (text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${String(c.charCodeAt(0))};`)
}

export function renderErrorPage (page: ErrorPage, host: string, detail: string): { status: number, html: string } {
  const { status, title, lead } = PAGES[page]
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="color-scheme" content="light dark"><title>${escapeHtml(title)}</title>
<style>body{font:15px/1.5 system-ui,sans-serif;max-width:40rem;margin:4rem auto;padding:0 1rem}code{word-break:break-all}.detail{opacity:.7;font-size:13px}</style></head>
<body><h1>${escapeHtml(title)}</h1><p>${escapeHtml(lead)}</p><p><code>${escapeHtml(host)}</code></p><p class="detail">${escapeHtml(detail)}</p></body></html>
`
  return { status, html }
}
