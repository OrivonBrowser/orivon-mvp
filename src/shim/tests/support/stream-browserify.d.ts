// stream-browserify ships no types. It exposes node:stream's API over
// readable-stream 3, which is all the rs3 test files need to import it as.
declare module 'stream-browserify' {
  export * from 'stream'
}
