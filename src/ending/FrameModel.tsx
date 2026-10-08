import { useMemo } from 'react'
import { useGLTF } from '@react-three/drei'
import { Box3, Mesh, Vector3, type Material, type MeshStandardMaterial } from 'three'
import type { FrameModelConfig } from '../config/schema'
import { DRACO_PATH, url, useKTX2Extension } from '../scene/EnvModel'
import { useEndingCfg } from '../state/useConfigStore'
import { hash01 } from './composition'

/** 当前画框的外轮廓半宽 / 半高（标本盒单位），相机自动取景用；0 = 还没加载 */
export const frameExtent = { halfW: 0, halfH: 0 }

/** model 模式用哪个画框：modelIndex = -1 时按组合 id 随机（同一组合每次一样） */
export function pickFrameModel(models: FrameModelConfig[], modelIndex: number, seed: string) {
  if (!models.length) return undefined
  const i = modelIndex >= 0 ? Math.min(modelIndex, models.length - 1) : Math.floor(hash01(seed, 101) * models.length)
  return models[i]
}

const box = new Box3()
const size = new Vector3()
const center = new Vector3()

/**
 * 画框模型：等比缩放到 height（厚度保持模型原比例），背面贴在标本盒后壁（-size.z / 2），
 * 构图仍按 frame.size 算，画框的内框大致对齐它（各画框的 height 在 ending.json 里按边框宽窄调过）。
 */
export function FrameModel({ cfg }: { cfg: FrameModelConfig }) {
  const back = useEndingCfg((c) => -c.frame.size[2] / 2)
  const { scene } = useGLTF(url(cfg.model), DRACO_PATH, undefined, useKTX2Extension())

  const object = useMemo(() => {
    const o = scene.clone(true)
    o.traverse((m) => {
      if (!(m instanceof Mesh)) return
      m.castShadow = true
      m.receiveShadow = true
      // 有的画框材质带透明通道（BLEND），当成镂空处理，免得和标本排序出错
      for (const mat of ([] as Material[]).concat(m.material)) {
        const std = mat as MeshStandardMaterial
        if (std.transparent) {
          std.transparent = false
          std.alphaTest = 0.5
          std.depthWrite = true
        }
      }
    })
    return o
  }, [scene])

  const fit = useMemo(() => {
    object.updateMatrixWorld(true)
    box.setFromObject(object)
    box.getSize(size)
    box.getCenter(center)
    const s = cfg.height / (size.y || 1)
    frameExtent.halfW = (size.x * s) / 2
    frameExtent.halfH = cfg.height / 2
    return {
      scale: s,
      position: [
        -center.x * s + cfg.offset[0],
        -center.y * s + cfg.offset[1],
        back - box.min.z * s + cfg.offset[2],
      ] as [number, number, number],
    }
  }, [object, cfg.height, cfg.offset, back])

  return (
    <group position={fit.position} scale={fit.scale}>
      <primitive object={object} />
    </group>
  )
}
