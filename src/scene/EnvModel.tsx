import { useEffect, useLayoutEffect, useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import { useThree } from '@react-three/fiber'
import { KTX2Loader } from 'three/examples/jsm/loaders/KTX2Loader.js'
import { Mesh, type Group, type Material, type Object3D, type Texture } from 'three'
import { useConfigStore, useSceneCfg } from '../state/useConfigStore'
import { isTerrainName } from '../materials/detail'
import { registerCollider, registerWaterBed } from './collision'
import { useEnvMaterials } from './envMaterials'

/** 自托管 Draco 解码器（public/draco），不走外部 CDN */
export const DRACO_PATH = `${import.meta.env.BASE_URL}draco/`

export const url = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`

/** KTX2 / Basis 贴图解码器（自托管 public/basis，全局只建一个，需要渲染器来判断 GPU 支持的压缩格式） */
let ktx2: KTX2Loader | null = null
export function useKTX2Extension() {
  const gl = useThree((s) => s.gl)
  ktx2 ??= new KTX2Loader().setTranscoderPath(`${import.meta.env.BASE_URL}basis/`).detectSupport(gl)
  // drei 的 GLTFLoader 类型来自 three-stdlib，只声明用到的方法
  return (loader: { setKTX2Loader(l: never): unknown }) => {
    loader.setKTX2Loader(ktx2 as never)
  }
}

/**
 * 给 useLoader 直接加载 .ktx2 贴图用：构造时返回上面那个全局实例
 * （每个实例都会单独加载转码器、开一组 worker）。用之前先调用 useKTX2Extension() 完成初始化。
 */
export class SharedKTX2Loader extends KTX2Loader {
  constructor() {
    super()
    if (!ktx2) throw new Error('KTX2Loader 还没初始化：先调用 useKTX2Extension()')
    return ktx2 as SharedKTX2Loader
  }
}

/** 场景切换时释放 GPU 资源并清出 useGLTF 缓存，避免三个场景叠加爆显存（spec §12.3） */
export function useDisposeOnUnmount(path: string, root: Object3D) {
  useEffect(
    () => () => {
      root.traverse((o) => {
        if (!(o instanceof Mesh)) return
        o.geometry.disposeBoundsTree?.()
        o.geometry.dispose()
        const mats: Material[] = Array.isArray(o.material) ? o.material : [o.material]
        for (const m of mats) {
          for (const v of Object.values(m)) if ((v as Texture | null)?.isTexture) (v as Texture).dispose()
          m.dispose()
        }
      })
      useGLTF.clear(url(path))
    },
    [path, root],
  )
}

export function useEnvTransform() {
  const scale = useSceneCfg((c) => c.env.scale)
  const position = useSceneCfg((c) => c.env.position)
  const rotationY = useSceneCfg((c) => c.env.rotationY)
  return { scale, position, rotation: [0, rotationY, 0] as [number, number, number] }
}

const EXTRA = 'edenEnvExtra'

/**
 * 渲染用环境模型。
 * extras（env.extras，如海洋的气泡）挂在主模型 scene 下面当子节点：主模型怎么变换它就跟着怎么动，
 * 材质也和主模型走同一套流水线（登记进 look dev 面板）；叠加模型（玻璃类）不投阴影。
 */
export function EnvModel({ path, extras = [] }: { path: string; extras?: string[] }) {
  const ktx2 = useKTX2Extension()
  const [{ scene }, ...extraGltfs] = useGLTF([path, ...extras].map(url), DRACO_PATH, undefined, ktx2)
  const t = useEnvTransform()
  const sceneId = useConfigStore((s) => s.scene)
  const extraScenes: Object3D[] = extraGltfs.map((g) => g.scene)

  // 必须在材质收集（useEnvMaterials 的 useMemo）之前挂好，所以放在渲染阶段（重复 add 只是重新挂一次）
  const extraMeshes = useMemo(() => {
    for (const child of [...scene.children]) if (child.userData[EXTRA] && !extraScenes.includes(child)) scene.remove(child)
    const meshes = new Set<Object3D>()
    for (const s of extraScenes) {
      s.userData[EXTRA] = true
      scene.add(s)
      s.traverse((o) => meshes.add(o))
    }
    return meshes
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scene, ...extraScenes])

  useDisposeOnUnmount(path, scene)
  useEffect(() => () => extras.forEach((p) => useGLTF.clear(url(p))), [extras.join(',')])
  useEnvMaterials(sceneId, scene, { castShadow: (mesh) => !extraMeshes.has(mesh) })
  // 地形 mesh 登记为水底（烘水深图用）；变换改变时重新登记，保证 matrixWorld 是最新的
  useLayoutEffect(
    () =>
      registerWaterBed(scene, (mesh) =>
        (Array.isArray(mesh.material) ? mesh.material : [mesh.material]).some((m: Material) => isTerrainName(m.name)),
      ),
    [scene, t.scale, t.position, t.rotation[1]],
  )
  return (
    <group {...t}>
      <primitive object={scene} />
    </group>
  )
}

/** 碰撞体：不渲染，只用于射线检测 */
export function ColliderModel({ path }: { path: string }) {
  const { scene } = useGLTF(url(path), DRACO_PATH)
  const collider = useMemo(() => scene.clone(true) as Group, [scene])
  const t = useEnvTransform()
  useDisposeOnUnmount(path, scene)

  useLayoutEffect(() => {
    collider.visible = false
    return registerCollider(collider)
    // 变换改变时重新注册，保证 matrixWorld 是最新的
  }, [collider, t.scale, t.position, t.rotation[1]])

  return (
    <group {...t}>
      <primitive object={collider} />
    </group>
  )
}

/**
 * Landing 期间预热：只预取文件进 HTTP 缓存。
 * （useGLTF.preload 需要在有渲染器时才能配置 KTX2 解码器，Landing 是纯 2D 页面，没有渲染器）
 */
export function preloadEnv(model: string, collider: string) {
  for (const p of [model, collider]) if (p) void fetch(url(p)).catch(() => {})
}
