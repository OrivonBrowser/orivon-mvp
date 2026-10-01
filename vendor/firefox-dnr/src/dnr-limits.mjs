/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Ported from ExtensionDNRLimits.sys.mjs. See vendor/firefox-dnr/UPSTREAM.md
// patch 4: values are Chrome's published declarativeNetRequest limits
// (developer.chrome.com/docs/extensions/reference/api/declarativeNetRequest),
// not Firefox's own pref defaults, so that an extension built against Chrome
// is not rejected below the ceiling it was written for. Firefox's defaults
// (in comments below) are a same-generation reference point, not what is
// enforced here. `XPCOMUtils.declareLazy`'s pref indirection is dropped: a
// pure engine has no pref service, only these constants.
export const ExtensionDNRLimits = {
  /** Minimum static rules guaranteed across an extension's enabled rulesets. */
  GUARANTEED_MINIMUM_STATIC_RULES: 30000, // Firefox default: 30000 (matches)

  /** Maximum static rulesets an extension can list in "rule_resources". */
  MAX_NUMBER_OF_STATIC_RULESETS: 100, // Firefox default: 100 (matches)

  /** Maximum static rulesets an extension can have enabled at once. */
  MAX_NUMBER_OF_ENABLED_STATIC_RULESETS: 50, // Firefox default: 20 (differs)

  /** Maximum individually-disabled rule ids across one static ruleset. */
  MAX_NUMBER_OF_DISABLED_STATIC_RULES: 5000, // Firefox default: 5000 (matches)

  /**
   * Maximum dynamic rules an extension can add. Chrome splits this into a
   * 30000-rule total and a 5000-rule "safe" sub-quota for rules it can keep
   * indexed cheaply; that split is not implemented (RuleValidator has no
   * concept of a "safe" rule, matching upstream Firefox), so this is the
   * flat total an extension may add.
   */
  MAX_NUMBER_OF_DYNAMIC_RULES: 30000, // Firefox default: 5000 (differs)

  /** Maximum session-scoped rules an extension can add. */
  MAX_NUMBER_OF_SESSION_RULES: 5000, // Firefox default: 5000 (matches)

  /** Maximum rules with a regexFilter condition, counted per ruleset kind. */
  MAX_NUMBER_OF_REGEX_RULES: 1000, // Firefox default: 1000 (matches)
}
