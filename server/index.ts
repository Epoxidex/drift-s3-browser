import { loadEnvFile } from 'node:process'
import { buildApp } from './app.js'
import { destroyClients } from './connection-store.js'

try {
  loadEnvFile('.env')
} catch {
  // Environment variables may be supplied by the host.
}

const app = await buildApp()
const host = process.env.HOST || '127.0.0.1'
const port = Number(process.env.PORT) || 4173

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, async () => {
    destroyClients()
    await app.close()
    process.exit(0)
  })
}

try {
  await app.listen({ host, port })
  console.log(`S3 Browser API: http://${host}:${port}`)
} catch (error) {
  console.error(error)
  process.exit(1)
}
