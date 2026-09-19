import { getAsset } from '../data/assets'
import { useEndingCfg } from '../state/useConfigStore'
import type { SceneId } from '../config/schema'
import { SpecimenSlot } from './SpecimenSlot'

/** 3D 画框（占位几何）：四条边框 + 背板 */
function Frame3D() {
  const { size, border, color, metalness, roughness, backColor, backRoughness } = useEndingCfg((c) => c.frame)
  const [w, h, d] = size
  return (
    <group>
      <mesh position={[0, 0, -d / 2]}>
        <boxGeometry args={[w, h, 0.05]} />
        <meshStandardMaterial color={backColor} roughness={backRoughness} />
      </mesh>
      {[
        [0, h / 2 + border / 2, w + border * 2, border],
        [0, -h / 2 - border / 2, w + border * 2, border],
      ].map(([x, y, bw, bh], i) => (
        <mesh key={`h${i}`} position={[x, y, 0]}>
          <boxGeometry args={[bw, bh, d]} />
          <meshStandardMaterial color={color} metalness={metalness} roughness={roughness} />
        </mesh>
      ))}
      {[-1, 1].map((side) => (
        <mesh key={`v${side}`} position={[side * (w / 2 + border / 2), 0, 0]}>
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

  return (
    <group>
      {mode === '3d' ? <Frame3D /> : <FramePlane />}
      <SpecimenSlot slot={slots.slotA} asset={getAsset(selections.cave)} />
      <SpecimenSlot slot={slots.slotB} asset={getAsset(selections.ocean)} />
      <SpecimenSlot slot={slots.slotC} asset={getAsset(selections.garden)} />
    </group>
  )
}
