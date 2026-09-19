import { useSceneCfg } from '../state/useConfigStore'

// 采集区本身是隐形触发器，判定逻辑在 AssetFlow 里（逐帧比较角色与 zoneCenter 的水平距离）。
// 这里只画一个淡淡的地面圈用于占位阶段定位，placeholder.zoneOpacity 设为 0 即隐藏。
export function CollectZone() {
  const [x, y, z] = useSceneCfg((c) => c.flow.zoneCenter)
  const radius = useSceneCfg((c) => c.flow.zoneRadius)
  const { zoneColor, zoneOpacity } = useSceneCfg((c) => c.placeholder)
  if (zoneOpacity <= 0) return null
  return (
    <mesh position={[x, y + 0.01, z]} rotation={[-Math.PI / 2, 0, 0]}>
      <circleGeometry args={[radius, 64]} />
      <meshBasicMaterial color={zoneColor} transparent opacity={zoneOpacity} depthWrite={false} />
    </mesh>
  )
}
