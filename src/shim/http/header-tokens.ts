// The patterns http/ reads header text with, defined once. A token is a header
// name or a method; the connection and coding patterns match one word inside a
// comma-separated value, as Node's own do.

export const HTTP_TOKEN = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/
/** Anything a header value or a status message may not carry. */
export const INVALID_HEADER_CONTENT = /[^\t\x20-\x7e\x80-\xff]/
export const CONNECTION_CLOSE = /(?:^|\W)close(?:$|\W)/i
export const CONNECTION_KEEP_ALIVE = /(?:^|\W)keep-alive(?:$|\W)/i
export const CONNECTION_UPGRADE = /(?:^|\W)upgrade(?:$|\W)/i
export const CODING_CHUNKED = /(?:^|\W)chunked(?:$|\W)/i
