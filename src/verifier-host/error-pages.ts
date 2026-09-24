// The four pages a `.eth` tab shows instead of content. Static text only:
// each is served with `default-src 'none'`, so nothing on it can run or load.

import type { ResolutionFailure } from '../resolution/records.js'

export type ErrorPage = 'cannot-verify-yet' | 'cannot-verify' | 'not-found' | 'unsupported'

export const ERROR_PAGE_CSP = "default-src 'none'; style-src 'unsafe-inline'"

const PAGES: Readonly<Record<ErrorPage, { status: number, title: string, lead: string }>> = {
  'cannot-verify-yet': {
    status: 503,
    title: 'Cannot verify this name yet',
    lead: "Orivon's Ethereum light client is still catching up with the chain, so it cannot yet prove what this name points to. Nothing unverified is shown in the meantime. Reload in a moment."
  },
  'cannot-verify': {
    status: 502,
    title: 'Cannot verify this site',
    lead: "Orivon could not check this site against what the Ethereum chain says the name points to, so nothing from it is shown. The servers that answered may be down, or one may have sent data that failed its check."
  },
  'not-found': {
    status: 404,
    title: 'Nothing here',
    lead: 'The chain says this name points to no content, or the content has no file at this address.'
  },
  unsupported: {
    status: 501,
    title: 'This kind of site is not supported',
    lead: 'This name points to content this version of Orivon cannot load and verify.'
  }
}

export function pageFor (failure: ResolutionFailure): ErrorPage {
  switch (failure) {
    case 'not-synced': return 'cannot-verify-yet'
    case 'unverifiable':
    case 'unavailable': return 'cannot-verify'
    case 'not-found':
    case 'invalid-name': return 'not-found'
    case 'unsupported': return 'unsupported'
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
