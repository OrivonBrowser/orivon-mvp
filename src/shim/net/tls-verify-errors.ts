// The error Node destroys a TLS socket with when certificate verification
// fails, rebuilt from the code the broker reports: the same `code` and the
// same text, so an app that prints the error tells the person what Node would.

/**
 * OpenSSL 3's X509_verify_cert_error_string text for each code Node names
 * (deps/ncrypto's X509Pointer::ErrorCode). Node 24 appends a hint about its
 * --use-system-ca flag to some of these; that flag does not exist here, so the
 * hint is left out on purpose.
 */
const VERIFY_ERROR_TEXT: Readonly<Record<string, string>> = {
  UNABLE_TO_GET_ISSUER_CERT: 'unable to get issuer certificate',
  UNABLE_TO_GET_CRL: 'unable to get certificate CRL',
  UNABLE_TO_DECRYPT_CERT_SIGNATURE: "unable to decrypt certificate's signature",
  UNABLE_TO_DECRYPT_CRL_SIGNATURE: "unable to decrypt CRL's signature",
  UNABLE_TO_DECODE_ISSUER_PUBLIC_KEY: 'unable to decode issuer public key',
  CERT_SIGNATURE_FAILURE: 'certificate signature failure',
  CRL_SIGNATURE_FAILURE: 'CRL signature failure',
  CERT_NOT_YET_VALID: 'certificate is not yet valid',
  CERT_HAS_EXPIRED: 'certificate has expired',
  CRL_NOT_YET_VALID: 'CRL is not yet valid',
  CRL_HAS_EXPIRED: 'CRL has expired',
  ERROR_IN_CERT_NOT_BEFORE_FIELD: "format error in certificate's notBefore field",
  ERROR_IN_CERT_NOT_AFTER_FIELD: "format error in certificate's notAfter field",
  ERROR_IN_CRL_LAST_UPDATE_FIELD: "format error in CRL's lastUpdate field",
  ERROR_IN_CRL_NEXT_UPDATE_FIELD: "format error in CRL's nextUpdate field",
  OUT_OF_MEM: 'out of memory',
  DEPTH_ZERO_SELF_SIGNED_CERT: 'self-signed certificate',
  SELF_SIGNED_CERT_IN_CHAIN: 'self-signed certificate in certificate chain',
  UNABLE_TO_GET_ISSUER_CERT_LOCALLY: 'unable to get local issuer certificate',
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: 'unable to verify the first certificate',
  CERT_CHAIN_TOO_LONG: 'certificate chain too long',
  CERT_REVOKED: 'certificate revoked',
  INVALID_CA: 'invalid CA certificate',
  PATH_LENGTH_EXCEEDED: 'path length constraint exceeded',
  INVALID_PURPOSE: 'unsuitable certificate purpose',
  CERT_UNTRUSTED: 'certificate not trusted',
  CERT_REJECTED: 'certificate rejected',
  HOSTNAME_MISMATCH: 'hostname mismatch',
  // Node's default checkServerIdentity; the broker reports the code without the reason it appends.
  ERR_TLS_CERT_ALTNAME_INVALID: "Hostname/IP does not match certificate's altnames"
}

/** Whether `code` is a certificate verification failure, as opposed to a network error. */
export function isVerificationCode (code: unknown): code is string {
  return typeof code === 'string' && Object.hasOwn(VERIFY_ERROR_TEXT, code)
}

export function verificationError (code: string): Error & { code: string } {
  const text = isVerificationCode(code) ? VERIFY_ERROR_TEXT[code] : undefined
  return Object.assign(new Error(text ?? `certificate verification failed: ${code}`), { code })
}
