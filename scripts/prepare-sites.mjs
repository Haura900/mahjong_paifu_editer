import { cp, mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const dist = resolve(root, 'dist')
const client = resolve(dist, 'client')
const server = resolve(dist, 'server')

await mkdir(client, { recursive: true })
await mkdir(server, { recursive: true })

for (const entry of ['assets', 'index.html', 'manifest.webmanifest', 'og.png', 'sw.js', 'tiles']) {
  await cp(resolve(dist, entry), resolve(client, entry), { recursive: true })
}

await writeFile(
  resolve(server, 'index.js'),
  `const worker = {
  async fetch(request, env) {
    const response = await env.ASSETS.fetch(request)
    if (response.status !== 404 || !request.headers.get('accept')?.includes('text/html')) {
      return response
    }
    const indexUrl = new URL('/index.html', request.url)
    return env.ASSETS.fetch(new Request(indexUrl, request))
  },
}

export default worker
`,
  'utf8',
)
