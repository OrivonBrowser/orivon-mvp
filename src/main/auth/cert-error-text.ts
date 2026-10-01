// The network errors that mean a server's certificate was not accepted, and what the sheet says for each. A code
// that is not one of these is some other failure and gets no sheet.

/** Chromium's `net::ERR_CERT_*` codes, by number, with one plain sentence for the person. */
const REASONS: ReadonlyMap<number, string> = new Map([
  [-200, 'The certificate is for a different site name than the one you asked for.'],
  [-201, 'The certificate has expired or is not valid yet. Check that this computer\'s date and time are right.'],
  [-202, 'The certificate was not issued by an authority this computer trusts.'],
  [-203, 'The certificate has errors.'],
  [-204, 'The certificate has no way to be checked for revocation.'],
  [-205, 'Whether the certificate was revoked could not be checked.'],
  [-206, 'The authority that issued the certificate has revoked it.'],
  [-207, 'The certificate is not valid.'],
  [-208, 'The certificate is signed with an algorithm that is no longer safe.'],
  [-210, 'The certificate names a host that is not unique to this site.'],
  [-211, 'The certificate uses a key that is too weak.'],
  [-212, 'The certificate goes against the limits its issuer set.'],
  [-213, 'The certificate is valid for longer than browsers accept.'],
  [-214, 'The certificate is missing the public record browsers require.'],
  [-215, 'The certificate comes from an authority browsers no longer trust.']
])

const FALLBACK = 'The certificate could not be verified.'

/** Whether `code` is a certificate failure: Chromium keeps them in one block. */
export function isCertError (code: number): boolean {
  return Number.isInteger(code) && code <= -200 && code >= -220
}

/** The sentence for a certificate failure code; every code in the block has one. */
export function certErrorText (code: number): string {
  return REASONS.get(code) ?? FALLBACK
}

/** The longest host the sheet names. */
export const MAX_HOST = 253
