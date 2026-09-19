// 构建产物检查（spec §9.5）：生产 bundle 里不允许出现 Theatre / Tweakpane 等开发期工具。
// 用法：npm run build && npm run check:bundle
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

const FORBIDDEN = [/theatre/i, /tweakpane/i]
const files = []
const walk = (dir) => {
  for (const f of readdirSync(dir)) {
    const p = join(dir, f)
    if (statSync(p).isDirectory()) walk(p)
    else if (/\.(js|mjs|css|html)$/.test(f)) files.push(p)
  }
}
walk('dist')
if (!files.length) {
  console.error('dist 为空，先运行 npm run build')
  process.exit(1)
}
const hits = []
for (const f of files) {
  const src = readFileSync(f, 'utf8')
  for (const re of FORBIDDEN) if (re.test(src)) hits.push(`${f}: ${re}`)
}
if (hits.length) {
  console.error('生产 bundle 中发现开发期工具：\n' + hits.join('\n'))
  process.exit(1)
}
console.log(`check:bundle 通过（${files.length} 个文件，不含 ${FORBIDDEN.map(String).join(' / ')}）`)
