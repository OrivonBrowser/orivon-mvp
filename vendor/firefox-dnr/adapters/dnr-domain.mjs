/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Adapter replacing Services.eTLD.getBaseDomain (ExtensionDNR.sys.mjs's
// RequestDetails#isThirdParty), which reads Firefox's compiled-in public
// suffix list. See vendor/firefox-dnr/UPSTREAM.md patch 3.
//
// `tldts` (MIT, pure JS/JSON data, no native code, no install script) is a
// public-suffix-list lookup: `getDomain(hostname)` returns the registrable
// base domain (the public suffix plus one label), or null when none can be
// computed (an IP address, or a host that IS its own suffix, e.g.
// "localhost" or a bare unlisted TLD). That null contract already matches
// what this function documented before the switch, so callers (this
// package's #isThirdParty) are unchanged.
//
// `allowPrivateDomains: true` also honors the PSL's PRIVATE section (e.g.
// "github.io", "blogspot.com"), so two different users' sites under a
// shared hosting platform are graded thirdParty rather than merged into one
// base domain -- the same choice Firefox's own eTLD service makes by
// default, and the fix for the fixed-list heuristic this replaces, which
// graded "example.github.io" one label too broad.
import { getDomain } from 'tldts'

const GET_DOMAIN_OPTIONS = { allowPrivateDomains: true }

/**
 * `.orivon` (Orivon's own app-serving TLD), `.eth` (ENS names) and
 * `<cid>.ipfs.orivon` (content-addressed IPFS gateways) are not on the
 * public suffix list `tldts` ships, so it falls back to its default rule --
 * treat the unrecognized label as an ordinary suffix and take one label
 * above it as the base domain:
 *   - "sub.example.orivon" / "app.eth" -> "example.orivon" / "app.eth":
 *     sensible, and matches how a normal unlisted TLD would be treated --
 *     one registrable label under the TLD is exactly the firstParty/
 *     thirdParty grouping the "domainType" condition wants.
 *   - "<cid>.ipfs.orivon" -> "ipfs.orivon" for every CID: one label too
 *     broad, the same failure shape the fixed-list heuristic this replaces
 *     already had for "example.github.io" (-> "github.io") -- every
 *     unrelated IPFS-hosted site under this scheme would be graded
 *     "firstParty" with every other one. Acceptable for the same reason
 *     that case was: it only affects the "domainType" condition (an ad-
 *     blocker's own first/third-party heuristic), not requestDomains/
 *     initiatorDomains, which do not use getBaseDomain at all, and DNR
 *     rulesets rarely gate on domainType for a scheme this narrow. Settling
 *     it precisely needs `ipfs.orivon` listed the way the real public
 *     suffix list lists "github.io" (as a PRIVATE-section suffix), which
 *     `tldts` cannot know about without Orivon shipping a patched data file.
 *
 * @param {string} hostname - Lowercase hostname (punycode, no port/brackets).
 * @returns {string|null} The registrable base domain, or null if none can
 *   be computed. Callers fall back to plain domain comparison in that case,
 *   matching how the upstream Services.eTLD call is guarded by a try/catch
 *   at its one call site.
 */
export function getBaseDomain(hostname) {
  return getDomain(hostname, GET_DOMAIN_OPTIONS)
}
