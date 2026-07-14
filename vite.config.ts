import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:4173',
        configure(proxy) {
          proxy.on('error', (_error, _request, response) => {
            if ('writeHead' in response && !response.headersSent) {
              response.writeHead(503, { 'content-type': 'application/json; charset=utf-8' })
              response.end(JSON.stringify({
                error: 'API-сервер недоступен. Остановите старый процесс и заново запустите npm run dev.',
              }))
            }
          })
        },
      },
    },
  },
  build: {
    outDir: 'dist/client',
  },
})
