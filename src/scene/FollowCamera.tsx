import { useEffect, useRef } from 'react'
import { useFrame, useThree } from '@react-three/fiber'
import { MathUtils, PerspectiveCamera, Vector3 } from 'three'
import { consumeLook } from '../input/useInput'
import { getSceneCfg, useSceneCfg } from '../state/useConfigStore'
import { groundHeight, hitDistance } from './collision'
import { dampFactor, forwardFromYaw, rig } from './rig'

const fwd = new Vector3()
const desired = new Vector3()
const lookAt = new Vector3()
const toCam = new Vector3()

// 第三人称与第一人称共用同一套平滑：位置与视线目标都用 camera.damping 做阻尼插值，
// 只有「刚进场景 / 切换视角 / 被地形遮挡」这三种情况直接吸附。
export function FollowCamera() {
  const camera = useThree((s) => s.camera) as PerspectiveCamera
  const { fov, near, far } = useSceneCfg((c) => c.camera)

  useEffect(() => {
    camera.fov = fov
    camera.near = near
    camera.far = far
    camera.updateProjectionMatrix()
  }, [camera, fov, near, far])

  // 进入场景的第一帧直接放到目标位置，不从原点飞过来
  const snap = useRef(true)
  const mode = useRef('')
  /** 平滑后的视线目标 */
  const smoothLook = useRef(new Vector3())

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1)
    const c = getSceneCfg().camera
    const { dx, dy } = consumeLook()
    rig.yaw -= dx * c.rotateSpeed
    rig.pitch = MathUtils.clamp(rig.pitch + dy * c.rotateSpeed, c.pitchMin, c.pitchMax)

    forwardFromYaw(rig.yaw, fwd)
    const modeChanged = mode.current !== c.mode
    mode.current = c.mode
    let occluded = false

    if (c.mode === 'first') {
      // 第一人称：相机在眼睛高度，视线目标在正前方一米处
      desired.copy(rig.position).setY(rig.position.y + c.eyeHeight)
      lookAt
        .copy(fwd)
        .multiplyScalar(Math.cos(rig.pitch))
        .setY(-Math.sin(rig.pitch))
        .add(desired)
    } else {
      const horiz = c.followDistance * Math.cos(rig.pitch)
      desired
        .copy(rig.position)
        .addScaledVector(fwd, -horiz)
        .setY(rig.position.y + c.followHeight + c.followDistance * Math.sin(rig.pitch))

      // 遮挡：从角色视点向目标相机位置发射线，被地形挡住就把相机拉近到遮挡点之前
      lookAt.copy(rig.position).setY(rig.position.y + c.lookAtOffset)
      toCam.subVectors(desired, lookAt)
      const full = toCam.length()
      if (full > 1e-4) {
        toCam.divideScalar(full)
        const hit = hitDistance(lookAt, toCam, full)
        if (hit !== null) {
          desired.copy(lookAt).addScaledVector(toCam, Math.max(c.minDistance, hit - c.occlusionPadding))
          occluded = true
        }
      }
    }

    // 被遮挡时立即拉近（不走阻尼），否则会有一瞬间看到墙背面
    if (snap.current || modeChanged || occluded) {
      camera.position.copy(desired)
      smoothLook.current.copy(lookAt)
      snap.current = false
    } else {
      const k = dampFactor(c.damping, dt)
      camera.position.lerp(desired, k)
      smoothLook.current.lerp(lookAt, k)
    }

    // 相机不钻进地形（第一人称的相机跟着角色，不需要）
    if (c.mode !== 'first') {
      const g = groundHeight(camera.position.x, camera.position.z, camera.position.y + c.followHeight, c.followHeight * 4)
      if (g !== null && camera.position.y < g + c.minGroundClearance) camera.position.y = g + c.minGroundClearance
    }

    camera.lookAt(smoothLook.current)
  })

  return null
}
