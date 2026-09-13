// A59 probe -- throwaway, not shipped source. See ../../docs/open-questions.md A59.
//
// The URL matrix: A59's own "AI recommendation" named scheme, port, path,
// query string and trailing slash as the minimum axes; the lane brief adds a
// percent-encoded segment, a duplicate slash, an uppercase host, an IDN host,
// a fragment and userinfo -- the shapes where a re-derivation bug (rather
// than a plain redirect) would actually surface. IDN_LABEL is a \u escape,
// not a literal accented character, so this file stays ASCII source.
const IDN_LABEL = '\u00e9' // e-acute, as in caf-plus-IDN_LABEL

function httpCases (port) {
  const base = `http://127.0.0.1:${port}`
  return [
    { label: 'http-plain-path', url: `${base}/plain` },
    { label: 'http-trailing-slash', url: `${base}/dir/` },
    { label: 'http-no-trailing-slash', url: `${base}/dir` },
    { label: 'http-query-string', url: `${base}/search?q=hello&x=1` },
    { label: 'http-percent-encoded-segment', url: `${base}/a%2Fb/c%20d` },
    { label: 'http-duplicate-slash', url: `${base}/a//b//c` },
    { label: 'http-fragment', url: `${base}/frag#section-two` },
    { label: 'http-query-and-fragment', url: `${base}/combo?a=1&b=two#tail` },
    { label: 'http-unicode-query-value', url: `${base}/search?name=%E6%97%A5%E6%9C%AC` },
    { label: 'http-userinfo', url: `http://probeuser:probepass@127.0.0.1:${port}/secure` },
    { label: 'http-uppercase-host', url: `http://LOCALHOST:${port}/case-test` },
    { label: 'http-idn-host-punycode', url: `http://xn--caf-dma.localhost:${port}/idn-test` },
    { label: 'http-idn-host-unicode', url: `http://caf${IDN_LABEL}.localhost:${port}/idn-test-unicode` },
    { label: 'http-ipv6-literal', url: `http://[::1]:${port}/ipv6-test` }
  ]
}

function httpsCases (port) {
  const base = `https://127.0.0.1:${port}`
  return [
    { label: 'https-plain-path', url: `${base}/plain` },
    { label: 'https-trailing-slash', url: `${base}/dir/` },
    { label: 'https-query-string', url: `${base}/search?q=hello&x=1` },
    { label: 'https-percent-encoded-segment', url: `${base}/a%2Fb/c%20d` },
    { label: 'https-uppercase-host', url: `https://LOCALHOST:${port}/case-test` },
    { label: 'https-idn-host-punycode', url: `https://xn--caf-dma.localhost:${port}/idn-test` },
    { label: 'https-ipv6-literal', url: `https://[::1]:${port}/ipv6-test` }
  ]
}

module.exports = { httpCases, httpsCases }
