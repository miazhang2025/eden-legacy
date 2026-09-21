import { useEffect, useMemo, useState } from 'react'
import { useFrame, useLoader } from '@react-three/fiber'
import {
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DataUtils,
  HalfFloatType,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  LinearFilter,
  NoColorSpace,
  RGBAFormat,
  TextureLoader,
} from 'three'
import type { SceneConfig } from '../config/schema'
import { createGrassMaterial, createGrassUniforms } from '../materials/GrassMaterial'
import { getSceneCfg, useSceneCfg } from '../state/useConfigStore'
import { useTier } from '../state/useQualityStore'
import { hasCollider, terrainHeight } from './collision'
import { LAYER_VEGETATION } from './envMaterials'

// 程序化草（spec §5.2A 风动植被的补充）：一个 draw call，CPU 每帧只推相机位置。

const url = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`
const HEIGHT_RES = 256

interface MaskBounds {
  min: [number, number]
  size: [number, number]
}

/** 一片草叶：三段、7 个顶点、5 个三角形（x ∈ [-0.5, 0.5]，y ∈ [0, 1]） */
function bladeGeometry(): BufferGeometry {
  const g = new BufferGeometry()
  const ys = [0, 1 / 3, 2 / 3]
  const pos: number[] = []
  for (const y of ys) pos.push(-0.5, y, 0, 0.5, y, 0)
  pos.push(0, 1, 0)
  g.setAttribute('position', new BufferAttribute(new Float32Array(pos), 3))
  g.setIndex([0, 1, 2, 1, 3, 2, 2, 3, 4, 3, 5, 4, 4, 5, 6])
  return g
}

/** 从碰撞体按密度图同一网格烘高度图：R = 世界高度，G = 是否命中地形 */
function bakeHeightMap(bounds: MaskBounds, env: SceneConfig['env']): DataTexture {
  const data = new Uint16Array(HEIGHT_RES * HEIGHT_RES * 4)
  const cr = Math.cos(env.rotationY)
  const sr = Math.sin(env.rotationY)
  for (let j = 0; j < HEIGHT_RES; j++) {
    for (let i = 0; i < HEIGHT_RES; i++) {
      // 模型局部 → 世界
      const lx = bounds.min[0] + ((i + 0.5) / HEIGHT_RES) * bounds.size[0]
      const lz = bounds.min[1] + ((j + 0.5) / HEIGHT_RES) * bounds.size[1]
      const x = (cr * lx + sr * lz) * env.scale + env.position[0]
      const z = (-sr * lx + cr * lz) * env.scale + env.position[2]
      const h = terrainHeight(x, z, 1e4)
      const k = (j * HEIGHT_RES + i) * 4
      data[k] = DataUtils.toHalfFloat(h ?? 0)
      data[k + 1] = DataUtils.toHalfFloat(h === null ? 0 : 1)
      data[k + 3] = DataUtils.toHalfFloat(1)
    }
  }
  const tex = new DataTexture(data, HEIGHT_RES, HEIGHT_RES, RGBAFormat, HalfFloatType)
  tex.magFilter = LinearFilter
  tex.minFilter = LinearFilter
  tex.needsUpdate = true
  return tex
}

export function Grass() {
  const enabled = useSceneCfg((c) => c.grass.enabled && c.grass.mask !== '')
  const mask = useSceneCfg((c) => c.grass.mask)
  if (!enabled) return null
  return <GrassField mask={mask} />
}

function GrassField({ mask }: { mask: string }) {
  const g = useSceneCfg((c) => c.grass)
  const env = useSceneCfg((c) => c.env)
  const tier = useTier()

  const maskTex = useLoader(TextureLoader, url(mask))
  const [bounds, setBounds] = useState<MaskBounds | null>(null)
  useEffect(() => {
    let alive = true
    fetch(url(mask.replace(/\.png$/, '.json')))
      .then((r) => r.json())
      .then((b: MaskBounds) => alive && setBounds(b))
      .catch(() => console.warn(`[grass] 缺少密度图范围文件：${mask.replace(/\.png$/, '.json')}（运行 npm run models）`))
    return () => {
      alive = false
    }
  }, [mask])
  useEffect(() => {
    maskTex.colorSpace = NoColorSpace
    maskTex.magFilter = LinearFilter
    maskTex.needsUpdate = true
  }, [maskTex])

  // 高度图：碰撞体就绪 + 范围已知后烘一次；env 变换变化时重烘
  const [colliderReady, setColliderReady] = useState(hasCollider)
  // config 每次更新都会整体克隆，按值比较 env，避免调别的参数时重烘（6.5 万次射线）
  const envKey = JSON.stringify(env)
  const heightMap = useMemo(
    () => (colliderReady && bounds ? bakeHeightMap(bounds, JSON.parse(envKey)) : null),
    [colliderReady, bounds, envKey],
  )
  useEffect(() => () => heightMap?.dispose(), [heightMap])

  // 实例网格：边长 = √(数量 × 档位倍率)
  const side = Math.max(1, Math.floor(Math.sqrt(g.count * tier.grass)))
  const geometry = useMemo(() => {
    const blade = bladeGeometry()
    const geo = new InstancedBufferGeometry()
    geo.index = blade.index
    geo.setAttribute('position', blade.getAttribute('position'))
    const cells = new Float32Array(side * side * 2)
    for (let j = 0; j < side; j++)
      for (let i = 0; i < side; i++) {
        cells[(j * side + i) * 2] = i
        cells[(j * side + i) * 2 + 1] = j
      }
    geo.setAttribute('aCell', new InstancedBufferAttribute(cells, 2))
    geo.instanceCount = side * side
    return geo
  }, [side])
  useEffect(() => () => geometry.dispose(), [geometry])

  const uniforms = useMemo(createGrassUniforms, [])
  const material = useMemo(() => createGrassMaterial(uniforms), [uniforms])
  useEffect(() => () => material.dispose(), [material])

  useFrame(({ camera }) => {
    if (!colliderReady && hasCollider()) setColliderReady(true)
    const c = getSceneCfg()
    const gc = c.grass
    const u = uniforms
    u.uCenter.value.set(camera.position.x, camera.position.z)
    u.uRadius.value = gc.radius
    u.uSide.value = side
    u.uCell.value = (gc.radius * 2) / side
    u.uFadeStart.value = gc.fadeStart
    u.uMask.value = maskTex
    u.uHeightMap.value = heightMap
    if (bounds) u.uMaskBounds.value.set(bounds.min[0], bounds.min[1], bounds.size[0], bounds.size[1])
    u.uEnv.value.set(c.env.position[0], c.env.position[2], c.env.scale, c.env.rotationY)
    u.uThreshold.value = gc.densityThreshold
    u.uBladeHeight.value.set(...gc.bladeHeight)
    u.uBladeWidth.value = gc.bladeWidth
    u.uBend.value = gc.bend
    u.uBaseColor.value.set(gc.baseColor)
    u.uTipColor.value.set(gc.tipColor)
    u.uColorVar.value = gc.colorVariation
    u.uNormalUp.value = gc.normalUp
    u.uWindInfluence.value = gc.windInfluence
    u.uGrassSSS.value = gc.sss
  })

  if (!heightMap || !bounds || tier.grass <= 0) return null
  return (
    <mesh
      // 植被层：主相机可见，实时反射可排除
      ref={(m) => void m?.layers.set(LAYER_VEGETATION)}
      geometry={geometry}
      material={material}
      frustumCulled={false}
      receiveShadow={g.receiveShadow}
      castShadow={false}
    />
  )
}
