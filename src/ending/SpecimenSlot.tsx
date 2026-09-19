import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Box3, Color, DoubleSide, Matrix4, Mesh, MeshStandardMaterial, Vector3, type Group } from 'three'
import type { SlotConfig } from '../config/schema'
import type { CollectableAssetDef } from '../data/assets'
import { useEndingCfg } from '../state/useConfigStore'
import { PlaceholderModel } from '../scene/PlaceholderModel'

const box = new Box3()
const part = new Box3()
const size = new Vector3()
const center = new Vector3()
const inv = new Matrix4()
const rel = new Matrix4()

/** 在 root 自身局部空间里的包围盒（不受父级旋转缩放影响） */
function localBounds(root: Group, out: Box3) {
  root.updateMatrixWorld(true)
  inv.copy(root.matrixWorld).invert()
  out.makeEmpty()
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return
    if (!o.geometry.boundingBox) o.geometry.computeBoundingBox()
    rel.multiplyMatrices(inv, o.matrixWorld)
    out.union(part.copy(o.geometry.boundingBox!).applyMatrix4(rel))
  })
  return out
}

export function SpecimenSlot({ slot, asset }: { slot: SlotConfig; asset: CollectableAssetDef | undefined }) {
  const inner = useRef<Group>(null)
  const { emissiveIntensity, roughness, metalness } = useEndingCfg((c) => c.specimen)

  const material = useMemo(
    () =>
      asset &&
      new MeshStandardMaterial({
        color: new Color(asset.placeholderColor),
        emissive: new Color(asset.glowColor),
        emissiveIntensity,
        roughness,
        metalness,
        side: DoubleSide,
      }),
    [asset, emissiveIntensity, roughness, metalness],
  )
  useEffect(() => () => material?.dispose(), [material])

  // autoFit：按包围盒最长边缩放到 fitSize，并把包围盒中心对齐 slot 原点
  useLayoutEffect(() => {
    const g = inner.current
    if (!g || !asset) return
    g.scale.setScalar(1)
    g.position.set(0, 0, 0)
    localBounds(g, box)
    box.getSize(size)
    box.getCenter(center)
    const longest = Math.max(size.x, size.y, size.z) || 1
    const s = slot.autoFit ? slot.fitSize / longest : (asset.specimenScale ?? 1)
    g.scale.setScalar(s)
    if (slot.autoFit) g.position.copy(center).multiplyScalar(-s)
  }, [asset, slot.autoFit, slot.fitSize, slot.position, slot.rotation, slot.scale])

  if (!asset || !material) return null
  return (
    <group position={slot.position} rotation={slot.rotation} scale={slot.scale}>
      <group ref={inner}>
        <PlaceholderModel category={asset.category} material={material} />
      </group>
    </group>
  )
}
