import { Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { Box3, Color, DoubleSide, Matrix4, Mesh, MeshStandardMaterial, SkinnedMesh, Vector3, type Group, type Material } from 'three'
import type { Placement } from './composition'
import { useEndingCfg } from '../state/useConfigStore'
import { AssetModel } from '../scene/AssetModel'
import { PlaceholderModel } from '../scene/PlaceholderModel'
import { useEndingUi } from './useEndingUi'
import { flatteningQuaternion, relativeMatrix } from './flatten'
import { velvetSurface } from './FrameModel'
import { segment } from './reveal'
import type { ThreeEvent } from '@react-three/fiber'

const box = new Box3()
const part = new Box3()
const size = new Vector3()
const center = new Vector3()
const rel = new Matrix4()
/** 标本背面离绒布表面的最小距离（标本盒单位） */
const VELVET_GAP = 0.01

/** 在 root 自身局部空间里的包围盒（不受父级旋转缩放影响） */
function localBounds(root: Group, out: Box3) {
  root.updateMatrixWorld(true)
  out.makeEmpty()
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return
    // 带骨骼的按当前姿态算（停在展翅姿态的蝴蝶），不用静止姿态的几何包围盒
    let local: Box3
    if (o instanceof SkinnedMesh) {
      o.computeBoundingBox()
      local = o.boundingBox!
    } else {
      if (!o.geometry.boundingBox) o.geometry.computeBoundingBox()
      local = o.geometry.boundingBox!
    }
    relativeMatrix(o, root, rel)
    out.union(part.copy(local).applyMatrix4(rel))
  })
  return out
}

// 层级：outer（落位点 + 入场 / 漂浮动画）→ fit（自动缩放 + 居中）→ turn（构图旋转）→ flat（摊平）→ 模型
// flat：真实模型加载后转到投影面积最大的朝向正对背板（见 flatten.ts），像钉在盒里的标本
// fit 在 turn 外面，所以测出的是「转过之后」的包围盒，缩放能让旋转后的外形刚好装进 region
export function SpecimenSlot({ index, placement }: { index: number; placement: Placement }) {
  const { asset, position, rotation, region, scale } = placement
  const fit = useRef<Group>(null)
  const flat = useRef<Group>(null)
  const outer = useRef<Group>(null)
  const reveal = useEndingCfg((c) => c.reveal)
  const { floatAmplitude, floatSpeed } = useEndingCfg((c) => c.composition)
  const { emissiveIntensity, roughness, metalness, hoverEmissive } = useEndingCfg((c) => c.specimen)

  const material = useMemo(
    () =>
      asset &&
      new MeshStandardMaterial({
        color: new Color(asset.placeholderColor),
        emissive: new Color(asset.glowColor),
        roughness,
        metalness,
        side: DoubleSide,
      }),
    [asset, roughness, metalness],
  )
  useEffect(() => () => material?.dispose(), [material])

  // 逐帧控制淡入的材质：占位几何体用上面那个（另有悬停发光），真实模型由 AssetModel 交过来（保持资产自带材质，只改透明度）；
  // 真实模型是异步加载的，交过来之后再做一次自动适配（loaded 进依赖）
  const placeholder = !asset || asset.model === 'placeholder'
  const mats = useRef<Material[]>([])
  const [loaded, setLoaded] = useState(0)
  useEffect(() => {
    if (placeholder && material) mats.current = [material]
  }, [placeholder, material])
  const onMaterials = useCallback((m: Material[]) => {
    mats.current = m
    setLoaded((n) => n + 1)
  }, [])

  // 标本投射与接收阴影
  useLayoutEffect(() => {
    outer.current?.traverse((o) => {
      o.castShadow = true
      o.receiveShadow = true
    })
  }, [asset])

  // 入场：标本盒放到一半时开始，三件依次错开落位并淡入
  // 落位后轻微漂浮，三件相位错开
  useFrame((state) => {
    const g = outer.current
    if (!g || !material) return
    const p = segment(reveal.boxDuration * 0.5 + index * reveal.specimenStagger, reveal.specimenDuration)
    const bob = Math.sin(state.clock.elapsedTime * floatSpeed * Math.PI * 2 + index * 2.1) * floatAmplitude * p
    // 落位深度不低于绒布表面（各画框背板深浅不一，薄的标本会被绒布盖住）
    const z = Number.isFinite(velvetSurface.z) ? Math.max(position[2], velvetSurface.z + VELVET_GAP) : position[2]
    g.position.set(
      position[0] + reveal.specimenFrom[0] * (1 - p),
      position[1] + reveal.specimenFrom[1] * (1 - p) + bob,
      z + reveal.specimenFrom[2] * (1 - p),
    )
    material.emissiveIntensity = useEndingUi.getState().hoveredId === asset?.id ? hoverEmissive : emissiveIntensity
    for (const m of mats.current) {
      m.opacity = p
      m.transparent = p < 1
    }
    g.visible = p > 0.001
  })


  // 自动适配：等比缩放到刚好装进 region（取三轴里最紧的一个）；x / y 把包围盒中心对齐落位点，
  // z 把背面贴在落位点上（像钉在背板上的标本，厚的只往前凸，不会穿进背板）
  useLayoutEffect(() => {
    const g = fit.current
    // 摊平（占位几何体、upright 的资产不转）
    const f = flat.current
    if (f) {
      f.quaternion.identity()
      if (!placeholder && loaded > 0 && asset?.specimenPose !== 'upright') f.quaternion.copy(flatteningQuaternion(f))
    }
    if (!g || !asset) return
    g.scale.setScalar(1)
    g.position.set(0, 0, 0)
    localBounds(g, box)
    box.getSize(size)
    box.getCenter(center)
    const s = Math.min(region[0] / (size.x || 1), region[1] / (size.y || 1), region[2] / (size.z || 1)) * scale
    g.scale.setScalar(s)
    g.position.set(-center.x * s, -center.y * s, -box.min.z * s)
  }, [asset, region, scale, rotation, loaded, placeholder])

  if (!asset || !material) return null
  const ui = useEndingUi.getState
  const at = (e: ThreeEvent<PointerEvent | MouseEvent>) => [e.nativeEvent.clientX, e.nativeEvent.clientY] as const
  return (
    <group
      ref={outer}
      position={position}
      onPointerOver={(e) => {
        e.stopPropagation()
        if (e.nativeEvent.pointerType === 'mouse' && !ui().dragging) ui().hover(asset.id, ...at(e))
      }}
      onPointerMove={(e) => {
        if (e.nativeEvent.pointerType === 'mouse' && ui().hoveredId === asset.id) ui().hover(asset.id, ...at(e))
      }}
      onPointerOut={(e) => {
        if (e.nativeEvent.pointerType === 'mouse' && ui().hoveredId === asset.id) ui().hover(null)
      }}
      onClick={(e) => {
        // 触屏没有 hover：点按切换提示框（拖拽超过阈值不算点击）
        if ((e.nativeEvent as PointerEvent).pointerType === 'mouse' || e.delta > 6) return
        e.stopPropagation()
        ui().hover(ui().hoveredId === asset.id ? null : asset.id, ...at(e))
      }}
    >
      <group ref={fit}>
        <group rotation={rotation}>
          <group ref={flat}>
            {placeholder ? (
              <PlaceholderModel category={asset.category} material={material} />
            ) : (
              <Suspense fallback={null}>
                {/* 蝴蝶：停在翅膀展得最开的一帧，再由 flat 平铺正对背板 */}
                <AssetModel def={asset} onMaterials={onMaterials} pose={asset.category === 'butterfly' ? 'spread' : 'animate'} />
              </Suspense>
            )}
          </group>
        </group>
      </group>
    </group>
  )
}
