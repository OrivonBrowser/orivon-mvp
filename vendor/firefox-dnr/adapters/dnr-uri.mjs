/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

// Adapter replacing Services.io.newURI and nsIURIMutator
// (ExtensionDNR.sys.mjs's applyQueryTransform/applyURLTransform), which are
// XPCOM interfaces that do not exist outside Firefox. WHATWG URL is the
// direct equivalent for a canonical http(s) URL, which is all DNR handles.
// See vendor/firefox-dnr/UPSTREAM.md patch 2 for the one behavioural gap
// this introduces: URL's setters clamp or ignore an invalid component
// instead of throwing, so a malformed redirect.transform that nsIURIMutator
// would reject is more likely to be accepted here.

/** @param {string} spec @returns {URL} @throws {Error} if spec is not a valid URL. */
export function newURI(spec) {
  try {
    return new URL(spec)
  } catch {
    throw new Error(`Invalid URL: ${spec}`)
  }
}

/**
 * @param {string} uriQuery - The query of a URL to transform, without "?".
 * @param {object} queryTransform - Rule.action.redirect.transform.queryTransform.
 * @returns {string} The uriQuery with the queryTransform applied, without "?".
 */
export function applyQueryTransform(uriQuery, queryTransform) {
  // URLSearchParams cannot be applied to the full query string, because that
  // API formats the full query string using form-urlencoding. But the input
  // may be in a different format. So we try to only modify matched params.
  function urlencode(s) {
    // application/x-www-form-urlencoded, which URLSearchParams itself uses
    // for the full string, differs from encodeURIComponent in how it encodes
    // " " ("+" vs "%20") and "!'()~" (raw vs "%21%27%28%29%7E").
    return new URLSearchParams({ s }).toString().slice(2)
  }
  if (!uriQuery.length && !queryTransform.addOrReplaceParams) {
    return ''
  }
  const removeParamsSet = new Set(queryTransform.removeParams?.map(urlencode))
  const addParams = (queryTransform.addOrReplaceParams || []).map(orig => ({
    normalizedKey: urlencode(orig.key),
    orig,
  }))
  const finalParams = []
  if (uriQuery.length) {
    for (const part of uriQuery.split('&')) {
      const key = part.split('=', 1)[0]
      if (removeParamsSet.has(key)) {
        continue
      }
      const i = addParams.findIndex(p => p.normalizedKey === key)
      if (i !== -1) {
        // Replace the found param with the key-value from addOrReplaceParams,
        // then drop it so a repeated key finds the next specified pair, if
        // any, and so it is not appended again after the loop.
        finalParams.push(`${key}=${urlencode(addParams[i].orig.value)}`)
        addParams.splice(i, 1)
      } else {
        finalParams.push(part)
      }
    }
  }
  for (const { normalizedKey, orig } of addParams) {
    if (!orig.replaceOnly) {
      finalParams.push(`${normalizedKey}=${urlencode(orig.value)}`)
    }
  }
  return finalParams.length ? `?${finalParams.join('&')}` : ''
}

/**
 * @param {URL} uri - Usually a http(s) URL.
 * @param {object} transform - Rule.action.redirect.transform.
 * @returns {URL} A new URL with the transform applied.
 */
export function applyURLTransform(uri, transform) {
  const out = new URL(uri.href)
  if (transform.scheme) {
    // declarative_net_request.json only allows http(s) here.
    out.protocol = `${transform.scheme}:`
  }
  if (transform.username != null) {
    out.username = transform.username
  }
  if (transform.password != null) {
    out.password = transform.password
  }
  if (transform.host != null) {
    out.hostname = transform.host
  }
  if (transform.port != null) {
    // Empty string clears an explicit port, restoring the scheme's default.
    out.port = transform.port
  }
  if (transform.path != null) {
    out.pathname = transform.path
  }
  if (transform.query != null) {
    out.search = transform.query
  } else if (transform.queryTransform) {
    out.search = applyQueryTransform(
      uri.search.replace(/^\?/, ''),
      transform.queryTransform
    )
  }
  if (transform.fragment != null) {
    out.hash = transform.fragment
  }
  return out
}
