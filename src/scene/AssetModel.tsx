import { useEffect, useMemo, useRef } from 'react'
import { useAnimations, useGLTF } from '@react-three/drei'
import { useFrame } from '@react-three/fiber'
import { AnimationMixer, Box3, Mesh, SkinnedMesh, Vector3, type AnimationClip, type Group, type Material, type Object3D } from 'three'
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js'
import type { CollectableAssetDef } from '../data/assets'
import { patchSpecimenLook, updateSpecimenUniforms } from '../materials/specimenLook'
import { getGlobalCfg } from '../state/useConfigStore'
import { DRACO_PATH, url, useAnisotropy, useKTX2Extension } from './EnvModel'

const NO_CLIPS: AnimationClip[] = []

/** 「展开」姿态：取样帧数、每帧参与测量的顶点数上限 */
const POSE_SAMPLES = 48
const POSE_POINTS = 360

/** 模型上相距最远的两点之间的距离（抽样顶点；整体平移旋转不影响，翅膀张得越开越大） */
function spread(root: Object3D, points: Vector3[]) {
  root.updateMatrixWorld(true)
  const meshes: Mesh[] = []
  let total = 0
  root.traverse((m) => {
    if (m instanceof Mesh) {
      meshes.push(m)
      total += m.geometry.getAttribute('position').count
    }
  })
  const step = Math.max(1, Math.ceil(total / POSE_POINTS))
  let k = 0
  for (const m of meshes) {
    const count = m.geometry.getAttribute('position').count
    for (let i = 0; i < count; i += step) {
      const p = (points[k] ??= new Vector3())
      m.getVertexPosition(i, p).applyMatrix4(m.matrixWorld)
      k++
    }
  }
  let max = 0
  for (let i = 0; i < k; i++) for (let j = i + 1; j < k; j++) max = Math.max(max, points[i].distanceToSquared(points[j]))
  return max
}

/**
 * 把动画停在模型摊得最开的那一帧（蝴蝶：翅膀完全展平，翼尖相距最远）。
 * 骨骼 / 节点停在该姿态，之后不再播放。临时 mixer 不 stop（stop 会把姿态还原），留着随模型一起回收。
 */
function poseSpread(root: Object3D, clips: AnimationClip[]) {
  const clip = clips[0]
  if (!clip || clip.duration <= 0) return
  const mixer = new AnimationMixer(root)
  mixer.clipAction(clip).play()
  const points: Vector3[] = []
  let best = 0
  let bestSpread = -1
  for (let i = 0; i < POSE_SAMPLES; i++) {
    const t = (clip.duration * i) / POSE_SAMPLES
    mixer.setTime(t)
    const s = spread(root, points)
    if (s > bestSpread) {
      bestSpread = s
      best = t
    }
  }
  mixer.setTime(best)
  root.updateMatrixWorld(true)
  root.traverse((m) => {
    if (m instanceof SkinnedMesh) m.computeBoundingBox()
  })
}

/**
 * 真实资产模型（npm run assets 的输出）：材质与贴图沿用资产自带的，只叠一层标本影棚光（materials/specimenLook.ts）。
 * 克隆（带骨骼的用 SkeletonUtils）→ 每个实例一份材质副本（只为淡入淡出时单独改透明度）→
 * 包围盒居中、最长边缩放到 def.size 米（与占位几何体同一尺度）→ 循环播放模型自带的动画。
 * pose = spread：不播动画，停在摊得最开的一帧（标本盒里的蝴蝶展翅）。
 */
export function AssetModel({
  def,
  onMaterials,
  pose = 'animate',
}: {
  def: CollectableAssetDef
  onMaterials: (materials: Material[]) => void
  pose?: 'animate' | 'spread'
}) {
  const { scene, animations } = useGLTF(url(def.model), DRACO_PATH, undefined, useKTX2Extension())

  const { object, materials, fit } = useMemo(() => {
    const o = cloneSkinned(scene)
    if (pose === 'spread') poseSpread(o, animations)
    const mats: Material[] = []
    const cache = new Map<Material, Material>()
    const own = (m: Material) => {
      let c = cache.get(m)
      if (!c) {
        c = m.clone()
        // 标本影棚光：场景里和标本盒里同一套着色，颜色接近效果图
        patchSpecimenLook(c, def.specimenGrade)
        cache.set(m, c)
        mats.push(c)
      }
      return c
    }
    o.traverse((m) => {
      if (!(m instanceof Mesh)) return
      m.material = Array.isArray(m.material) ? m.material.map(own) : own(m.material)
      m.castShadow = true
      m.receiveShadow = true
      // 骨骼动画会让包围盒跑出静止姿态，不做视锥剔除免得边缘闪没
      if (m instanceof SkinnedMesh) m.frustumCulled = false
    })
    o.updateMatrixWorld(true)
    const box = new Box3().setFromObject(o)
    const size = box.getSize(new Vector3())
    const s = def.size / (Math.max(size.x, size.y, size.z) || 1)
    const center = box.getCenter(new Vector3()).multiplyScalar(-s)
    return { object: o, materials: mats, fit: { scale: s, position: center.toArray() as [number, number, number] } }
  }, [scene, def, pose, animations])

  useEffect(() => {
    onMaterials(materials)
    return () => materials.forEach((m) => m.dispose())
  }, [materials, onMaterials])
  useAnisotropy(object)

  // 影棚光参数是全局共享的 uniform，每帧同步（曝光随场景配置变化，look dev 面板可调）
  useFrame(({ gl }) => updateSpecimenUniforms(getGlobalCfg().specimenLook, gl.toneMappingExposure))

  const animRoot = useRef<Group>(null)
  const { actions } = useAnimations(pose === 'spread' ? NO_CLIPS : animations, animRoot)
  useEffect(() => {
    const list = Object.values(actions)
    list.forEach((a) => a?.reset().play())
    return () => list.forEach((a) => a?.stop())
  }, [actions])

  return (
    <group position={fit.position} scale={fit.scale}>
      <group ref={animRoot}>
        <primitive object={object} />
      </group>
    </group>
  )
}
