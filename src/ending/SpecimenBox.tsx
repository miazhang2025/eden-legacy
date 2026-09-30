import { useMemo, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { MathUtils, type Group } from 'three'
import { useEndingCfg } from '../state/useConfigStore'
import type { SceneId } from '../config/schema'
import { composeSpecimens } from './composition'
import { photoSubject } from './ExportPhoto'
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

// selections（来自 useRunStore）是决定标本盒形态的唯一输入；构图（谁做主体、摆在哪）由 composition 自动算出，
// seed（组合 id）决定镜像与旋转扰动，同一组合每次结果一致
export function SpecimenBox({ selections, seed }: { selections: Record<SceneId, string | null>; seed: string }) {
  const mode = useEndingCfg((c) => c.frame.mode)
  const frameSize = useEndingCfg((c) => c.frame.size)
  const composition = useEndingCfg((c) => c.composition)
  const reveal = useEndingCfg((c) => c.reveal)
  const group = useRef<Group>(null)
  const placements = useMemo(
    () => composeSpecimens(selections, composition, frameSize, seed),
    [selections, composition, frameSize, seed],
  )

  // 入场：整体从 boxScaleFrom 放到 1
  useFrame(() => {
    const p = segment(0, reveal.boxDuration)
    group.current?.scale.setScalar(MathUtils.lerp(reveal.boxScaleFrom, 1, p))
  })

  return (
    <group ref={group}>
      {/* 照片裁切以画框为准 */}
      <group ref={(g) => void (photoSubject.current = g)}>{mode === '3d' ? <Frame3D /> : <FramePlane />}</group>
      {placements.map((p, i) => (
        <SpecimenSlot key={p.scene} index={i} placement={p} />
      ))}
    </group>
  )
}
