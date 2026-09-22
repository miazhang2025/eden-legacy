import { NodeIO, getBounds } from '@gltf-transform/core'
const io = new NodeIO()
for (const f of process.argv.slice(2)) {
  const doc = await io.read(f)
  console.log('===', f)
  const rows = []
  for (const n of doc.getRoot().listNodes()) {
    const m = n.getMesh(); if (!m) continue
    const b = getBounds(n)
    const tris = m.listPrimitives().reduce((s, p) => s + (p.getIndices()?.getCount() ?? 0) / 3, 0)
    rows.push([m.getName() || n.getName(), Math.round(tris), (b.max[0]-b.min[0]).toFixed(1), (b.max[1]-b.min[1]).toFixed(1), (b.max[2]-b.min[2]).toFixed(1), m.listPrimitives()[0]?.listSemantics().join(',')])
  }
  console.log(rows.length, 'meshes')
  for (const r of rows) console.log('  ', r.join(' | '))
}
