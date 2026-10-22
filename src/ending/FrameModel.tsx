import { useEffect, useMemo } from 'react'
import { create } from 'zustand'
import { useGLTF } from '@react-three/drei'
import {
  Box3,
  CanvasTexture,
  CircleGeometry,
  Mesh,
  MeshPhysicalMaterial,
  Raycaster,
  RepeatWrapping,
  SRGBColorSpace,
  Vector3,
  type Material,
  type MeshStandardMaterial,
  type Object3D,
} from 'three'
import type { FrameModelConfig } from '../config/schema'
import { DRACO_PATH, url, useKTX2Extension } from '../scene/EnvModel'
import { useEndingCfg } from '../state/useConfigStore'
import { hash01 } from './composition'

/** 当前画框的外轮廓半宽 / 半高（标本盒单位），相机自动取景用；0 = 还没加载 */
export const frameExtent = { halfW: 0, halfH: 0 }

/** 绒布表面的深度（标本盒单位），标本不能落到它后面；NaN = 没有绒布 */
export const velvetSurface = { z: NaN }

/** 画框内框（从正前方看到的开口）椭圆，标本盒单位：圆心 cx / cy、半轴 halfW / halfH；null = 没量到（或不是模型画框） */
export interface FrameInner {
  cx: number
  cy: number
  halfW: number
  halfH: number
}
export const useFrameInner = create<{ inner: FrameInner | null }>()(() => ({ inner: null }))

/** model 模式用哪个画框：modelIndex = -1 时按组合 id 随机（同一组合每次一样） */
export function pickFrameModel(models: FrameModelConfig[], modelIndex: number, seed: string) {
  if (!models.length) return undefined
  const i = modelIndex >= 0 ? Math.min(modelIndex, models.length - 1) : Math.floor(hash01(seed, 101) * models.length)
  return models[i]
}

const box = new Box3()
const size = new Vector3()
const center = new Vector3()
const BACK = new Vector3(0, 0, -1)
const probe = new Vector3()

/** 画框内框（模型自身坐标）：背板前表面 z、内框椭圆的半宽 / 半高（以包围盒中心为圆心） */
interface Inner {
  back: number
  halfW: number
  halfH: number
}

/**
 * 从正前方打射线量内框：中心打到的是背板；沿 x / y 往外走，打到的面明显比背板靠前（进入画框边）就是内框边缘。
 * 只在刚克隆、还没挂进场景时调用（matrixWorld = 模型自身坐标）。
 */
function measureInner(o: Object3D, b: Box3): Inner | null {
  const rc = new Raycaster()
  b.getSize(size)
  b.getCenter(center)
  const cx = center.x
  const cy = center.y
  const hitZ = (x: number, y: number) => {
    rc.set(probe.set(x, y, b.max.z + 1), BACK)
    return rc.intersectObject(o, true)[0]?.point.z ?? null
  }
  const back = hitZ(cx, cy)
  if (back === null) return null
  const rim = size.z * 0.1
  const edge = (dx: number, dy: number, max: number) => {
    const steps = 200
    for (let i = 1; i <= steps; i++) {
      const t = (max * i) / steps
      const z = hitZ(cx + dx * t, cy + dy * t)
      if (z !== null && z > back + rim) return t
    }
    return null
  }
  const halfW = edge(1, 0, size.x / 2)
  const halfH = edge(0, 1, size.y / 2)
  return halfW && halfH ? { back, halfW, halfH } : null
}

/** 绒布颗粒：细密的明暗噪点（平铺），乘在底色上；grain = 最暗的点比底色暗多少 */
const grainTextures = new Map<number, CanvasTexture>()
function getGrainTexture(grain: number) {
  const key = Math.round(grain * 100)
  let tex = grainTextures.get(key)
  if (tex) return tex
  const n = 256
  const canvas = document.createElement('canvas')
  canvas.width = canvas.height = n
  const ctx = canvas.getContext('2d')!
  const img = ctx.createImageData(n, n)
  for (let i = 0; i < n * n; i++) {
    const v = 255 * (1 - (key / 100) * Math.random())
    img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v
    img.data[i * 4 + 3] = 255
  }
  ctx.putImageData(img, 0, 0)
  tex = new CanvasTexture(canvas)
  tex.wrapS = tex.wrapT = RepeatWrapping
  tex.repeat.set(6, 8)
  tex.colorSpace = SRGBColorSpace
  grainTextures.set(key, tex)
  return tex
}

/**
 * 画框模型：等比缩放到 height（厚度保持模型原比例），背面贴在标本盒后壁（-size.z / 2），
 * 构图仍按 frame.size 算，画框的内框大致对齐它（各画框的 height 在 ending.json 里按边框宽窄调过）。
 * 内框里铺一块绒布（frame.velvet），尺寸与深度按模型自动量出。
 */
export function FrameModel({ cfg }: { cfg: FrameModelConfig }) {
  const back = useEndingCfg((c) => -c.frame.size[2] / 2)
  const velvet = useEndingCfg((c) => c.frame.velvet)
  const { scene } = useGLTF(url(cfg.model), DRACO_PATH, undefined, useKTX2Extension())

  const { object, inner } = useMemo(() => {
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
    o.updateMatrixWorld(true)
    return { object: o, inner: measureInner(o, box.setFromObject(o)) }
  }, [scene])

  const fit = useMemo(() => {
    object.updateMatrixWorld(true)
    box.setFromObject(object)
    box.getSize(size)
    box.getCenter(center)
    const s = cfg.height / (size.y || 1)
    frameExtent.halfW = (size.x * s) / 2
    frameExtent.halfH = cfg.height / 2
    const position: [number, number, number] = [
      -center.x * s + cfg.offset[0],
      -center.y * s + cfg.offset[1],
      back - box.min.z * s + cfg.offset[2],
    ]
    return { scale: s, position }
  }, [object, cfg.height, cfg.offset, back])

  const velvetMaterial = useMemo(
    () => new MeshPhysicalMaterial({ roughness: 1, metalness: 0, sheenRoughness: 0.6 }),
    [],
  )
  useEffect(() => () => velvetMaterial.dispose(), [velvetMaterial])
  useEffect(() => {
    velvetMaterial.color.set(velvet.color)
    velvetMaterial.sheenColor.set(velvet.sheenColor)
    velvetMaterial.sheen = velvet.sheen
    const grain = velvet.grain > 0 ? getGrainTexture(velvet.grain) : null
    if (velvetMaterial.map !== grain) {
      // 有无贴图切换要重编译
      if (!velvetMaterial.map !== !grain) velvetMaterial.needsUpdate = true
      velvetMaterial.map = grain
    }
  }, [velvetMaterial, velvet])
  const geometry = useMemo(() => new CircleGeometry(1, 128), [])
  useEffect(() => () => geometry.dispose(), [geometry])

  const showVelvet = velvet.enabled && inner !== null
  const velvetZ = inner ? inner.back * fit.scale + fit.position[2] + velvet.offset : NaN
  // 内框椭圆给装饰花草用（防穿模），画框换了 / 卸载时清掉
  useEffect(() => {
    useFrameInner.setState({
      inner: inner && {
        cx: cfg.offset[0],
        cy: cfg.offset[1],
        halfW: inner.halfW * fit.scale,
        halfH: inner.halfH * fit.scale,
      },
    })
    return () => useFrameInner.setState({ inner: null })
  }, [inner, fit.scale, cfg.offset])

  useEffect(() => {
    velvetSurface.z = showVelvet ? velvetZ : NaN
    return () => {
      velvetSurface.z = NaN
    }
  }, [showVelvet, velvetZ])

  return (
    <>
      <group position={fit.position} scale={fit.scale}>
        <primitive object={object} />
      </group>
      {showVelvet && (
        <mesh
          geometry={geometry}
          material={velvetMaterial}
          // 内框中心 = 包围盒中心（画框是对称的），已被 fit 平移到 offset 处
          position={[cfg.offset[0], cfg.offset[1], velvetZ]}
          scale={[inner.halfW * fit.scale + velvet.margin, inner.halfH * fit.scale + velvet.margin, 1]}
          receiveShadow
        />
      )}
    </>
  )
}
