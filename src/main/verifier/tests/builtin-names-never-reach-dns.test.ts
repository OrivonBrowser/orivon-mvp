// A name a built-in protocol resolves is answered on this computer, whichever top-level domain it is under: `.og` goes where `.eth` goes.

import { describe, expect, it } from 'vitest'
import { BUILTIN_ADDRESSES } from '../../../protocols/builtin.js'
import { composeNoProxy } from '../no-proxy.js'
import { composeResolverRules } from '../resolver-rules.js'
import { namesVerifierHost, rootDotBypassRules, routedBypassRules } from '../../route/verifier-name-guard.js'

describe.each(['eth', 'og'])('a .%s name', (suffix) => {
  it('is mapped to the verifier, and its root-dot spellings to nowhere, by the resolver rules', () => {
    const rules = composeResolverRules({ devClauses: '', port: 4433, suffixes: BUILTIN_ADDRESSES.routedSuffixes(), existing: '' }).split(',')
    expect(rules).toContain(`MAP *.${suffix} 127.0.0.1:4433`)
    expect(rules).toContain(`MAP *.${suffix}. ~NOTFOUND`)
    expect(rules).toContain(`MAP *.${suffix}..* ~NOTFOUND`)
  })

  it('is kept from a proxy the environment names, and from one the system names', () => {
    expect(composeNoProxy('', BUILTIN_ADDRESSES.routedSuffixes()).split(',')).toContain(`.${suffix}`)
    expect(routedBypassRules()).toEqual(expect.arrayContaining([`*.${suffix}`, `*.${suffix}.`]))
    expect(rootDotBypassRules()).toContain(`*.${suffix}.`)
  })

  it('is a name the proxy guard refuses to send to a proxy, over https or plain http, with or without the root dot', () => {
    for (const url of [`https://linagee.${suffix}/`, `http://linagee.${suffix}/x`, `wss://linagee.${suffix}/`, `https://linagee.${suffix}./`]) expect(namesVerifierHost(url), url).toBe(true)
  })
})
