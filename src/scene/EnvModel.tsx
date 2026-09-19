import { useEffect, useLayoutEffect, useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import { Mesh, type Group, type Material, type Object3D, type Texture } from 'three'
import { useConfigStore, useSceneCfg } from '../state/useConfigStore'
import { registerCollider } from './collision'
import { useEnvMaterials } from './envMaterials'

/** 自托管 Draco 解码器（public/draco），不走外部 CDN */
export const DRACO_PATH = `${import.meta.env.BASE_URL}draco/`

const url = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`

/** 场景切换时释放 GPU 资源并清出 useGLTF 缓存，避免三个场景叠加爆显存（spec §12.3） */
function useDisposeOnUnmount(path: string, root: Object3D) {
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

/** 渲染用环境模型 */
export function EnvModel({ path }: { path: string }) {
  const { scene } = useGLTF(url(path), DRACO_PATH)
  const t = useEnvTransform()
  const sceneId = useConfigStore((s) => s.scene)
  useDisposeOnUnmount(path, scene)
  useEnvMaterials(sceneId, scene)
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

export function preloadEnv(model: string, collider: string) {
  if (model) useGLTF.preload(url(model), DRACO_PATH)
  if (collider) useGLTF.preload(url(collider), DRACO_PATH)
}
