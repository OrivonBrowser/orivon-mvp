/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Adapter replacing Services.eTLD.getBaseDomain (ExtensionDNR.sys.mjs's
// RequestDetails#isThirdParty), which reads Firefox's compiled-in public
// suffix list. See vendor/firefox-dnr/UPSTREAM.md patch 3.
//
// PROVISIONAL: this is a fixed-list heuristic, not a public suffix list. It
// covers the common two-label ccTLD suffixes seen in DNR test fixtures and
// real-world rulesets (uBlock Origin Lite's). A host under a suffix this
// list does not know about (e.g. "example.github.io") is graded one label
// too broad ("github.io" instead of "example.github.io" as the base
// domain), which only affects the "domainType" (firstParty/thirdParty)
// condition -- requestDomains/initiatorDomains do not use it. What would
// settle this: vendoring a public suffix list (e.g. `tldts`'s data file)
// if `domainType` accuracy on such hosts turns out to matter for a real
// ruleset.
const TWO_LABEL_SUFFIXES = new Set([
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'ltd.uk', 'plc.uk',
  'co.jp', 'or.jp', 'ne.jp', 'ac.jp',
  'co.nz', 'org.nz', 'govt.nz',
  'co.za', 'org.za',
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au',
  'com.br', 'net.br', 'org.br',
  'co.in', 'net.in', 'org.in',
  'co.kr', 'or.kr',
  'com.cn', 'net.cn', 'org.cn',
  'com.mx', 'com.ar', 'com.tr', 'com.sg', 'com.hk',
])

/**
 * @param {string} hostname - Lowercase hostname (punycode, no port/brackets).
 * @returns {string|null} The registrable base domain (e.g. "example.co.uk"
 *   for "www.example.co.uk"), or null if none can be computed (an IP
 *   address, "localhost", or a single-label host). Callers fall back to
 *   plain domain comparison in that case, matching how the upstream
 *   Services.eTLD call is guarded by a try/catch at its one call site.
 */
export function getBaseDomain(hostname) {
  if (!hostname || /^[\d.]+$/.test(hostname) || hostname.includes(':')) {
    // IPv4 or IPv6 address: not eligible for a base domain.
    return null
  }
  const labels = hostname.split('.').filter(Boolean)
  if (labels.length < 2) {
    return null
  }
  const lastTwo = labels.slice(-2).join('.')
  if (labels.length >= 3 && TWO_LABEL_SUFFIXES.has(lastTwo)) {
    return labels.slice(-3).join('.')
  }
  return lastTwo
}
