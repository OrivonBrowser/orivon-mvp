// The two library files the reader sends to a page, imported as text: the build inlines each file's source.
declare module '@mozilla/readability/Readability.js?raw' {
  const source: string
  export default source
}

declare module '@mozilla/readability/Readability-readerable.js?raw' {
  const source: string
  export default source
}
