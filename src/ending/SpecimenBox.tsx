import { useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { MathUtils, type Group } from 'three'
import { getAsset } from '../data/assets'
import { useEndingCfg } from '../state/useConfigStore'
import type { SceneId } from '../config/schema'
import { segment } from './reveal'
import { SpecimenSlot } from './SpecimenSlot'

/** 3D 画框（占位几何）：四条边框 + 背板 */
function Frame3D() {
  const { size, border, color, metalness, roughness, backColor, backRoughness } = useEndingCfg((c) => c.frame)
  const [w, h, d] = size
  return (
    <group>
      <mesh position={[0, 0, -d / 2]} receiveShadow>
        <boxGeometry args={[w, h, 0.05]} />
        <meshStandardMaterial color={backColor} roughness={backRoughness} />
      </mesh>
      {[
        [0, h / 2 + border / 2, w + border * 2, border],
        [0, -h / 2 - border / 2, w + border * 2, border],
      ].map(([x, y, bw, bh], i) => (
        <mesh key={`h${i}`} position={[x, y, 0]} castShadow receiveShadow>
          <boxGeometry args={[bw, bh, d]} />
          <meshStandardMaterial color={color} metalness={metalness} roughness={roughness} />
        </mesh>
      ))}
      {[-1, 1].map((side) => (
        <mesh key={`v${side}`} position={[side * (w / 2 + border / 2), 0, 0]} castShadow receiveShadow>
          <boxGeometry args={[border, h, d]} />
          <meshStandardMaterial color={color} metalness={metalness} roughness={roughness} />
        </mesh>
      ))}
    </group>
  )
}

/** 2D 画框模式：一张平面，之后换成带透明通道的贴图 */
function FramePlane() {
  const { size, border, color, roughness, planeDepth } = useEndingCfg((c) => c.frame)
  return (
    <mesh position={[0, 0, planeDepth]}>
      <planeGeometry args={[size[0] + border * 2, size[1] + border * 2]} />
      <meshStandardMaterial color={color} roughness={roughness} />
    </mesh>
  )
}

// selections（来自 useRunStore）是决定标本盒形态的唯一输入；slot 映射固定：A=cave, B=ocean, C=garden
export function SpecimenBox({ selections }: { selections: Record<SceneId, string | null> }) {
  const mode = useEndingCfg((c) => c.frame.mode)
  const slots = useEndingCfg((c) => c.slots)
  const reveal = useEndingCfg((c) => c.reveal)
  const group = useRef<Group>(null)

  // 入场：整体从 boxScaleFrom 放到 1
  useFrame(() => {
    const p = segment(0, reveal.boxDuration)
    group.current?.scale.setScalar(MathUtils.lerp(reveal.boxScaleFrom, 1, p))
  })

  return (
    <group ref={group}>
      {mode === '3d' ? <Frame3D /> : <FramePlane />}
      <SpecimenSlot index={0} slot={slots.slotA} asset={getAsset(selections.cave)} />
      <SpecimenSlot index={1} slot={slots.slotB} asset={getAsset(selections.ocean)} />
      <SpecimenSlot index={2} slot={slots.slotC} asset={getAsset(selections.garden)} />
    </group>
  )
}
