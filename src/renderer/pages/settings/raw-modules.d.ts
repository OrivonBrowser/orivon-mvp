// A file imported with `?raw` is its text, which Vite inlines into the bundle.
declare module '*?raw' {
  const text: string
  export default text
}
