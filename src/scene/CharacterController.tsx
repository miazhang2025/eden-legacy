import { useLayoutEffect, useRef } from 'react'
import { useFrame } from '@react-three/fiber'
import { MathUtils, Vector3, type Group } from 'three'
import type { SceneConfig } from '../config/schema'
import { getMove } from '../input/useInput'
import { getSceneCfg, useSceneCfg } from '../state/useConfigStore'
import { groundHeight, groundHeightFromSky, isBlocked } from './collision'
import { dampFactor, forwardFromYaw, rightFromYaw, rig } from './rig'

export type AnimName = 'idle' | 'walk'

const fwd = new Vector3()
const right = new Vector3()
const dir = new Vector3()
const stepDir = new Vector3()
const probe = new Vector3()
const lastValid = new Vector3()

/**
 * 尝试把角色从 rig.position 水平移动 (dx, dz)。合法返回目标地面高度，否则 null。
 *  - 前方膝盖高度的短射线命中碰撞体 → 阻挡（墙、岩石）
 *  - 目标点向下射线在 [当前+stepHeight, 当前-maxDrop] 内未命中 → 阻挡（陡坡过高 / 悬崖边 / 地形外）
 */
function tryMove(dx: number, dz: number, c: SceneConfig['character'], w: SceneConfig['water']): number | null {
  const len = Math.hypot(dx, dz)
  if (len < 1e-6) return null
  const p = rig.position
  stepDir.set(dx / len, 0, dz / len)
  probe.set(p.x, p.y + c.stepHeight + 0.05, p.z)
  if (isBlocked(probe, stepDir, len + c.radius)) return null
  const g = groundHeight(p.x + dx, p.z + dz, p.y + c.stepHeight, c.stepHeight + c.maxDrop)
  // 水深超过 blockDepth 的区域不可进入（浅水 / 汀步可以走）
  if (g !== null && w.enabled && w.blockDepth > 0 && w.level - g > w.blockDepth) return null
  return g
}

// 第三人称角色：射线贴地 + 手写碰撞 + bounds clamp（spec §5.1 / §6.1）
export function CharacterController() {
  const group = useRef<Group>(null)
  const anim = useRef<AnimName>('idle')
  const heading = useRef(0)
  const { radius, height, color } = useSceneCfg((c) => c.character)
  // 第一人称下强制隐藏角色模型
  const firstPerson = useSceneCfg((c) => c.camera.mode === 'first')
  const visible = useSceneCfg((c) => c.character.visible) && !firstPerson

  useLayoutEffect(() => {
    const c = getSceneCfg().character
    const [x, , z] = c.spawn
    rig.position.set(x, groundHeightFromSky(x, z) ?? 0, z)
    lastValid.copy(rig.position)
    rig.yaw = c.spawnYaw
    rig.pitch = getSceneCfg().camera.initialPitch
    heading.current = c.spawnYaw
  }, [])

  // DEV：把角色传送到某个 xz（自动贴地并重置「上一个合法位置」）。
  // 直接改 rig.position 会被贴地判定当成掉出地形而拉回出生点，调参 / 截图时用这个。
  useLayoutEffect(() => {
    if (!import.meta.env.DEV) return
    const teleport = (x: number, z: number, yaw?: number, pitch?: number) => {
      const y = groundHeightFromSky(x, z)
      if (y === null) return false
      rig.position.set(x, y, z)
      lastValid.copy(rig.position)
      if (yaw !== undefined) {
        rig.yaw = yaw
        heading.current = yaw
      }
      if (pitch !== undefined) rig.pitch = pitch
      return true
    }
    ;(window as unknown as Record<string, unknown>).__teleport = teleport
    return () => {
      delete (window as unknown as Record<string, unknown>).__teleport
    }
  }, [])

  const playAnim = (name: AnimName) => {
    if (anim.current === name) return
    anim.current = name
    // TODO: 角色资产到位后在这里切换动画
  }

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    const cfg = getSceneCfg()
    const c = cfg.character
    const move = getMove()
    forwardFromYaw(rig.yaw, fwd)
    rightFromYaw(rig.yaw, right)
    dir.set(0, 0, 0).addScaledVector(fwd, move.y).addScaledVector(right, move.x)

    const moving = dir.lengthSq() > 1e-4
    if (moving) {
      const speed = c.moveSpeed * (move.sprint ? c.sprintMultiplier : 1) * Math.min(1, dir.length())
      dir.normalize().multiplyScalar(speed * dt)

      // 先试整步，不行再沿单轴滑动（贴墙走）
      if (tryMove(dir.x, dir.z, c, cfg.water) !== null) {
        rig.position.x += dir.x
        rig.position.z += dir.z
      } else if (tryMove(dir.x, 0, c, cfg.water) !== null) {
        rig.position.x += dir.x
      } else if (tryMove(0, dir.z, c, cfg.water) !== null) {
        rig.position.z += dir.z
      }

      const target = Math.atan2(-dir.x, -dir.z)
      const delta = MathUtils.euclideanModulo(target - heading.current + Math.PI, Math.PI * 2) - Math.PI
      heading.current += delta * Math.min(1, c.turnSpeed * dt)
    }
    playAnim(moving ? 'walk' : 'idle')

    // bounds clamp（碰撞体之外的最后一道保险）
    const { min, max } = cfg.bounds
    rig.position.x = MathUtils.clamp(rig.position.x, min[0], max[0])
    rig.position.z = MathUtils.clamp(rig.position.z, min[2], max[2])

    // 贴地；脚下没有地面（掉出地形）→ 拉回上一个合法位置，不做死亡/重生
    const under = groundHeight(rig.position.x, rig.position.z, rig.position.y + c.stepHeight, c.stepHeight + c.maxDrop)
    if (under === null) {
      rig.position.copy(lastValid)
    } else {
      rig.position.y = Math.max(under, MathUtils.lerp(rig.position.y, under, dampFactor(c.groundSmoothing, dt)))
      lastValid.copy(rig.position)
    }

    if (group.current) {
      group.current.position.copy(rig.position)
      group.current.rotation.y = heading.current
    }
  })

  const bodyLength = Math.max(0.01, height - radius * 2)
  return (
    <group ref={group} visible={visible}>
      <mesh position={[0, height / 2, 0]} castShadow>
        <capsuleGeometry args={[radius, bodyLength, 6, 12]} />
        <meshStandardMaterial color={color} roughness={0.6} />
      </mesh>
      {/* 朝向指示 */}
      <mesh position={[0, height * 0.8, -radius]}>
        <boxGeometry args={[radius * 0.6, radius * 0.3, radius * 0.4]} />
        <meshStandardMaterial color={color} roughness={0.3} />
      </mesh>
    </group>
  )
}
