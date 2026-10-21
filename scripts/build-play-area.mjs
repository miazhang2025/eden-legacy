// 可玩区轮廓：从场景的碰撞体（env.collider + env.extraColliders）算岛的凸包，写进 config/scenes/<scene>.json 的 playArea.outline
//   轮廓在模型局部坐标（x/z），运行时套 env 变换；边界线 = 轮廓外扩 playArea.margin 米，泡泡排在边界线上
//   叠加碰撞体（场景人物）先套上 env.extrasTransform（作用在顶层 pivot 节点上，与运行时一致）
//
// 用法：npm run playarea -- ocean     碰撞体 / 人物位置改了之后重跑

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { NodeIO } from '@gltf-transform/core'
import { ALL_EXTENSIONS } from '@gltf-transform/extensions'
import draco3d from 'draco3dgltf'

const scene = process.argv[2]
if (!scene) {
  console.error('用法：npm run playarea -- <scene>')
  process.exit(1)
}
const file = join('src/config/scenes', `${scene}.json`)
const text = readFileSync(file, 'utf8')
const cfg = JSON.parse(text)

const io = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
  'draco3d.decoder': await draco3d.createDecoderModule(),
})

const list = (s) => String(s ?? '').split(',').map((p) => p.trim()).filter(Boolean)
const mul = (m, [x, y, z]) => [m[0] * x + m[4] * y + m[8] * z + m[12], m[2] * x + m[6] * y + m[10] * z + m[14]]

/** 碰撞体所有顶点的 x/z（模型局部） */
async function points(path, extra) {
  const doc = await io.read(join('public', path))
  if (extra) {
    const t = cfg.env.extrasTransform ?? { position: [0, 0, 0], rotationY: 0, scale: 1 }
    const half = t.rotationY / 2
    const spin = [0, Math.sin(half), 0, Math.cos(half)]
    for (const node of doc.getRoot().getDefaultScene()?.listChildren() ?? []) {
      if (node.getName() !== 'pivot') continue
      const p = node.getTranslation()
      const [qx, qy, qz, qw] = node.getRotation()
      const [sx, sy, sz, sw] = spin
      node.setTranslation([p[0] + t.position[0], p[1] + t.position[1], p[2] + t.position[2]])
      node.setRotation([
        sw * qx + sx * qw + sy * qz - sz * qy,
        sw * qy - sx * qz + sy * qw + sz * qx,
        sw * qz + sx * qy - sy * qx + sz * qw,
        sw * qw - sx * qx - sy * qy - sz * qz,
      ])
      node.setScale(node.getScale().map((v) => v * t.scale))
    }
  }
  const out = []
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh()
    if (!mesh) continue
    const m = node.getWorldMatrix()
    const v = [0, 0, 0]
    for (const prim of mesh.listPrimitives()) {
      const pos = prim.getAttribute('POSITION')
      for (let i = 0; i < pos.getCount(); i++) out.push(mul(m, pos.getElement(i, v)))
    }
  }
  return out
}

const pts = [
  ...(cfg.env.collider ? await points(cfg.env.collider, false) : []),
  ...(await Promise.all(list(cfg.env.extraColliders).map((p) => points(p, true)))).flat(),
]
if (pts.length < 3) {
  console.error(`${scene}：没有碰撞体顶点`)
  process.exit(1)
}

// 凸包（Andrew 单调链），逆时针
pts.sort((a, b) => a[0] - b[0] || a[1] - b[1])
const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0])
const half = (arr) => {
  const h = []
  for (const p of arr) {
    while (h.length >= 2 && cross(h[h.length - 2], h[h.length - 1], p) <= 0) h.pop()
    h.push(p)
  }
  h.pop()
  return h
}
let hull = [...half(pts), ...half([...pts].reverse())]

// 去掉几乎共线的点（离前后两点连线不到 5cm）：只会让轮廓往里缩这么一点
const TOL = 0.05
for (let i = 0; i < hull.length && hull.length > 3; ) {
  const a = hull[(i - 1 + hull.length) % hull.length]
  const b = hull[i]
  const c = hull[(i + 1) % hull.length]
  const d = Math.abs(cross(a, c, b)) / Math.hypot(c[0] - a[0], c[1] - a[1])
  if (d < TOL) hull.splice(i, 1)
  else i++
}
hull = hull.map(([x, z]) => [Math.round(x * 100) / 100, Math.round(z * 100) / 100])

cfg.playArea.outline = hull
const eol = text.includes('\r\n') ? '\r\n' : '\n'
writeFileSync(file, JSON.stringify(cfg, null, 2).replace(/\n/g, eol) + (/\r?\n$/.test(text) ? eol : ''))
let perimeter = 0
for (let i = 0; i < hull.length; i++) {
  const [ax, az] = hull[i]
  const [bx, bz] = hull[(i + 1) % hull.length]
  perimeter += Math.hypot(bx - ax, bz - az)
}
console.log(`${scene}：${pts.length} 个顶点 → 轮廓 ${hull.length} 个点，周长 ${perimeter.toFixed(1)} m（外扩 margin 后再加 2π·margin）→ ${file}`)
