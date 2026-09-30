import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { Box3, Color, DoubleSide, Matrix4, Mesh, MeshStandardMaterial, Vector3, type Group } from 'three'
import type { Placement } from './composition'
import { useEndingCfg } from '../state/useConfigStore'
import { PlaceholderModel } from '../scene/PlaceholderModel'
import { useEndingUi } from './useEndingUi'
import { segment } from './reveal'
import type { ThreeEvent } from '@react-three/fiber'

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

// 层级：outer（落位点 + 入场 / 漂浮动画）→ fit（自动缩放 + 居中）→ turn（构图旋转）→ 模型
// fit 在 turn 外面，所以测出的是「转过之后」的包围盒，缩放能让旋转后的外形刚好装进 region
export function SpecimenSlot({ index, placement }: { index: number; placement: Placement }) {
  const { asset, position, rotation, region, scale } = placement
  const fit = useRef<Group>(null)
  const outer = useRef<Group>(null)
  const reveal = useEndingCfg((c) => c.reveal)
  const { floatAmplitude, floatSpeed } = useEndingCfg((c) => c.composition)
  const { emissiveIntensity, roughness, metalness, hoverEmissive } = useEndingCfg((c) => c.specimen)
  const hovered = useEndingUi((s) => !!asset && s.hoveredId === asset.id)

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
    g.position.set(
      position[0] + reveal.specimenFrom[0] * (1 - p),
      position[1] + reveal.specimenFrom[1] * (1 - p) + bob,
      position[2] + reveal.specimenFrom[2] * (1 - p),
    )
    material.opacity = p
    material.transparent = p < 1
    g.visible = p > 0.001
  })

  // 悬停时自发光增强，提示哪一个是当前标本
  if (material) material.emissiveIntensity = hovered ? hoverEmissive : emissiveIntensity

  // 自动适配：等比缩放到刚好装进 region（取三轴里最紧的一个），再把包围盒中心对齐落位点
  useLayoutEffect(() => {
    const g = fit.current
    if (!g || !asset) return
    g.scale.setScalar(1)
    g.position.set(0, 0, 0)
    localBounds(g, box)
    box.getSize(size)
    box.getCenter(center)
    const s = Math.min(region[0] / (size.x || 1), region[1] / (size.y || 1), region[2] / (size.z || 1)) * scale
    g.scale.setScalar(s)
    g.position.copy(center).multiplyScalar(-s)
  }, [asset, region, scale, rotation])

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
          <PlaceholderModel category={asset.category} material={material} />
        </group>
      </group>
    </group>
  )
}
