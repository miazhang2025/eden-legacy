import { useEffect, useLayoutEffect, useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import { useLoader, useThree } from '@react-three/fiber'
import { InstancedMesh, Mesh, MeshStandardMaterial, RepeatWrapping, type Material, type Texture } from 'three'
import { patchCaustics } from '../materials/caustics'
import { createPeakMaterial, patchTerrain, setTerrainTextures } from '../materials/terrain'
import { useConfigStore, useSceneCfg } from '../state/useConfigStore'
import { useTier } from '../state/useQualityStore'
import { loadBoundaryField, setBoundaryField } from './boundary'
import { useEnvMaterials } from './envMaterials'
import { DRACO_PATH, SharedKTX2Loader, url, useAnisotropy, useDisposeOnUnmount, useEnvTransform, useKTX2Extension } from './EnvModel'

// 生成地形（scripts/build-terrain.mjs）：terrain_play 为可玩区，terrain_far 为远景裙边。
// 与环境模型共用 env 变换；裙边只接收阴影（阴影相机也照不到那么远）。
// 地面贴图（npm run ground 压的 KTX2）：中心 near、远景 far 两套，各三张（颜色 / 法线 / ORM）。

export function GeneratedTerrain({ path }: { path: string }) {
  const { scene } = useGLTF(url(path), DRACO_PATH, undefined, useKTX2Extension())
  const t = useEnvTransform()
  const near = useSceneCfg((c) => c.terrain.near)
  const far = useSceneCfg((c) => c.terrain.far)
  const gl = useThree((s) => s.gl)
  useDisposeOnUnmount(path, scene)

  const urls = [near.albedo, near.normal, near.orm, far.albedo, far.normal, far.orm].map(url)
  // 与模型共用同一个 KTX2Loader（上面的 useKTX2Extension 已初始化）
  const textures = useLoader(SharedKTX2Loader, urls)

  // 原地形的手绘贴图（painted 模式用），在生成地形 glb 的材质上
  const paint = useMemo(() => {
    let map: Texture | null = null
    scene.traverse((o) => {
      if (o instanceof Mesh && !map) map = (o.material as MeshStandardMaterial).map
    })
    return map as Texture | null
  }, [scene])

  useEffect(() => {
    for (const tex of textures) {
      tex.wrapS = tex.wrapT = RepeatWrapping
      tex.anisotropy = Math.min(4, gl.capabilities.getMaxAnisotropy())
      tex.needsUpdate = true
    }
    const [na, nn, no, fa, fn, fo] = textures
    setTerrainTextures({ near: [na, nn, no], far: [fa, fn, fo], paint })
    return () => setTerrainTextures(null)
  }, [textures, paint, gl])

  const material = useMemo(() => {
    const m = new MeshStandardMaterial({ name: 'generated_terrain', metalness: 0 })
    patchCaustics(m)
    patchTerrain(m)
    return m
  }, [])
  const peakMaterial = useMemo(createPeakMaterial, [])

  useLayoutEffect(() => {
    const originals: Array<[Mesh, Material]> = []
    scene.traverse((o) => {
      if (!(o instanceof Mesh)) return
      originals.push([o, o.material as Material])
      // 远景尖峰：空气透视材质，不投 / 不接阴影
      const isPeak = o.name === 'terrain_peaks'
      o.material = isPeak ? peakMaterial : material
      o.receiveShadow = !isPeak
      o.castShadow = o.name === 'terrain_play'
    })
    return () => {
      for (const [mesh, mat] of originals) mesh.material = mat
    }
  }, [scene, material, peakMaterial])

  useEffect(
    () => () => {
      material.dispose()
      peakMaterial.dispose()
    },
    [material, peakMaterial],
  )

  return (
    <group {...t}>
      <primitive object={scene} />
    </group>
  )
}

/** 可玩区距离场：加载后登记给角色控制器，卸载时清掉 */
export function BoundaryField({ map }: { map: string }) {
  useEffect(() => {
    let alive = true
    loadBoundaryField(map)
      .then((f) => alive && setBoundaryField(f))
      .catch(() => console.warn(`[terrain] 读不到可玩区距离场：${map}（运行 npm run terrain）`))
    return () => {
      alive = false
      setBoundaryField(null)
    }
  }, [map])
  return null
}

/**
 * 散布花草（scripts/build-scatter.mjs）：每个节点是一个 InstancedMesh（一种植物 × 区域 × 扇区）。
 * 材质名和原模型相同，风动 / SSS / look dev 覆盖照常生效；只有可玩区里的（节点名含 _inner）投阴影。
 * 实例在文件里已打乱，按 density × 档位倍率截断 count 就是随机抽稀。
 */
export function Scatter({ path }: { path: string }) {
  const { scene } = useGLTF(url(path), DRACO_PATH, undefined, useKTX2Extension())
  const t = useEnvTransform()
  const sceneId = useConfigStore((s) => s.scene)
  const density = useSceneCfg((c) => c.terrain.scatter.density)
  const tier = useTier()
  useDisposeOnUnmount(path, scene)
  useEnvMaterials(sceneId, scene, {
    register: false,
    castShadow: (m) => `${m.name}|${m.parent?.name ?? ''}`.includes('_inner'),
  })
  useAnisotropy(scene)

  useEffect(() => {
    const k = Math.max(0, Math.min(1, density * tier.scatter))
    scene.traverse((o) => {
      if (!(o instanceof InstancedMesh)) return
      o.userData.fullCount ??= o.count
      o.count = Math.round((o.userData.fullCount as number) * k)
    })
  }, [scene, density, tier.scatter])

  return (
    <group {...t}>
      <primitive object={scene} />
    </group>
  )
}
