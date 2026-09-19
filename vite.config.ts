import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** 仅 dev server：接收 Theatre 编辑器的「保存摆位」，写入 theatre/<id>.theatre-project-state.json */
function theatreSavePlugin(): Plugin {
  const ids = new Set(['cave', 'ocean', 'garden', 'ending'])
  return {
    name: 'eden:theatre-save',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__dev/theatre/', (req, res) => {
        const id = (req.url ?? '').replace(/^\//, '')
        if (req.method !== 'POST' || !ids.has(id)) {
          res.statusCode = 400
          res.end()
          return
        }
        let body = ''
        req.on('data', (chunk) => (body += chunk))
        req.on('end', () => {
          try {
            JSON.parse(body)
            const dir = resolve(server.config.root, 'theatre')
            mkdirSync(dir, { recursive: true })
            writeFileSync(resolve(dir, `${id}.theatre-project-state.json`), body + '\n')
            res.statusCode = 200
          } catch {
            res.statusCode = 400
          }
          res.end()
        })
      })
    },
  }
}

export default defineConfig({
  plugins: [react(), theatreSavePlugin()],
  base: './',
  server: {
    // 保存 state 文件不应触发整页刷新
    watch: { ignored: ['**/theatre/**'] },
  },
})
