// Throwaway isolation check -- not part of the probe's real matrix. Confirms
// the main.cjs result (response.url === '') is not an artifact of that
// harness: no options object, no body read, no custom cert/session code.
const { app, net } = require('electron')
const http = require('node:http')

async function main () {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' })
    res.end('hello')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  await app.whenReady()

  const url = `http://127.0.0.1:${port}/plain`
  const response = await net.fetch(url)
  console.log('requested:', url)
  console.log('response.url (bare fetch, no options):', JSON.stringify(response.url))
  console.log('response.type:', response.type)
  console.log('response.status:', response.status)
  console.log('response.redirected:', response.redirected)
  console.log('response.ok:', response.ok)
  const desc = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(response), 'url')
  console.log('url property descriptor kind:', desc ? (typeof desc.get === 'function' ? 'getter' : 'value') : 'not found on prototype')

  server.close()
  app.exit(0)
}

main().catch((e) => {
  console.error('FATAL', e)
  app.exit(1)
})
