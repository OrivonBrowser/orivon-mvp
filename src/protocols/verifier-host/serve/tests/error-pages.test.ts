import { describe, expect, it } from 'vitest'
import { renderErrorPage } from '../error-pages.js'

describe('the error page', () => {
  it('offers the gateways with the link it was given, and says what they would see and that nothing was sent', () => {
    const { html } = renderErrorPage('unavailable', 'ipfs://abc', 'the node is off', { href: '/.orivon/load-through-gateways?token=t&to=%2F', tunnelled: false })
    expect(html).toContain('id="load-through-gateways" href="/.orivon/load-through-gateways?token=t&#38;to=%2F"')
    expect(html).toContain('Load through public gateways')
    expect(html).toContain("this computer&#39;s address")
    expect(html).toContain('Nothing has been sent to any gateway')
    expect(html).toContain('Settings under Web3')
  })

  it('names the tunnel\'s exit instead of this computer for a website in the tunnel', () => {
    const { html } = renderErrorPage('unavailable', 'x', 'd', { href: '/.orivon/load-through-gateways', tunnelled: true })
    expect(html).toContain("the tunnel&#39;s exit address")
    expect(html).not.toContain("this computer&#39;s address")
  })

  it('offers nothing when it was not asked to', () => {
    expect(renderErrorPage('unavailable', 'x', 'd').html).not.toContain('Load through public gateways')
  })
})
