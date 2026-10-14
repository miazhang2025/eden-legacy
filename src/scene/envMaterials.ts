import { useEffect, useLayoutEffect, useMemo, useRef } from 'react'
import { Box3, Mesh, MeshDepthMaterial, RGBADepthPacking, Vector3, type Material, type MeshStandardMaterial, type Object3D } from 'three'
import { create } from 'zustand'
import CustomShaderMaterial from 'three-custom-shader-material/vanilla'
import { waterOn, type MaterialOverride, type MaterialRole, type SceneConfig, type SceneId, type TierSettings } from '../config/schema'
import { applyBubbleValues, bakeBubblePhase, createBubbleMaterial } from '../materials/BubbleMaterial'
import { createCrystalMaterial } from '../materials/CrystalMaterial'
import { shared } from '../materials/uniforms'
import { bakeVegetationAttributes, createVegetationMaterial, vegetationVertexShader } from '../materials/VegetationMaterial'
import { patchCaustics } from '../materials/caustics'
import { isTerrainName, patchDetail } from '../materials/detail'
import { patchPond } from '../materials/pond'
import { useSceneCfg } from '../state/useConfigStore'
import { useTier } from '../state/useQualityStore'
import {
  applyValues,
  defaultRole,
  isStandard,
  isPhysical,
  snapshot,
  useMaterialRegistry,
  type MaterialEntry,
} from './materialOverrides'

/** 渲染图层：植被放在 1 层（实时反射可选择排除），粒子在 2 层（永不进反射） */
export const LAYER_VEGETATION = 1
export const LAYER_PARTICLES = 2

/** 模型自带的粒子发射点（role = emitter 的 mesh 中心，世界坐标） */
export const useModelEmitters = create<{ positions: [number, number, number][] }>()(() => ({ positions: [] }))

const box = new Box3()
const size = new Vector3()
const center = new Vector3()

interface Collected {
  name: string
  sources: Material[]
  meshes: Mesh[]
  /** 与 meshes 一一对应的模型原材质 */
  originals: Material[]
}

function collect(root: Object3D): Collected[] {
  const map = new Map<string, Collected>()
  root.traverse((o) => {
    if (!(o instanceof Mesh)) return
    const m = o.material as Material
    if (!isStandard(m) || !m.name) return
    const c = map.get(m.name) ?? { name: m.name, sources: [], meshes: [], originals: [] }
    if (!c.sources.includes(m)) c.sources.push(m)
    c.meshes.push(o)
    c.originals.push(m)
    map.set(m.name, c)
  })
  return [...map.values()]
}

/** 植被阴影：深度材质也要带同样的风动位移，否则阴影不摆；镂空的（alpha 裁切，如蕨类）阴影也按贴图镂空 */
function vegetationDepthMaterial(src: MeshStandardMaterial) {
  const cutout = src.alphaTest > 0 && src.map ? { map: src.map, alphaTest: src.alphaTest } : {}
  return new CustomShaderMaterial({
    baseMaterial: MeshDepthMaterial,
    vertexShader: vegetationVertexShader,
    uniforms: shared,
    depthPacking: RGBADepthPacking,
    ...cutout,
    cacheKey: () => 'eden-vegetation-depth-v1',
  }) as unknown as Material
}

/**
 * 各角色在模型原值之上的「基础值」：面板覆盖叠加在它之上，拖动滑块时不用重建材质。
 * 晶体是否透射取决于档位与尺寸（spec §12.1：low 全部不透明，mid 仅主体，high 主体 + 次级）。
 */
function roleBase(e: MaterialEntry, cfg: SceneConfig, tier: TierSettings): Partial<MaterialOverride> {
  if (e.role === 'bubble') {
    const b = cfg.bubble
    // 泡泡靠透明混合，不用 transmission
    return { transparent: true, transmission: 0, roughness: b.roughness, envMapIntensity: b.envMapIntensity }
  }
  if (e.role !== 'crystal') return {}
  const c = cfg.crystal
  const isMain = e.size >= c.mainMinSize
  const transmissive = c.enabled && (tier.crystal === 'all' || (tier.crystal === 'main' && isMain))
  return transmissive
    ? { transmission: c.transmission, thickness: c.thickness, ior: c.ior, roughness: c.roughness, attenuationColor: c.attenuationColor }
    : { transmission: 0, envMapIntensity: c.opaqueEnvMapIntensity, roughness: c.roughness }
}

/**
 * 环境模型的材质流水线：
 * 1. 收集所有材质（按 name）
 * 2. 按角色转换：vegetation → 风动 + SSS；crystal → 透射；bubble → 透明薄膜 + 上下浮动（不投阴影）；emitter → 隐藏并登记发射点；water → 水面平面开启时隐藏
 * 3. 登记到材质注册表（look dev 面板用）
 * 4. 应用 config.materials 覆盖（叠加在角色基础值之上）
 *
 * options（给同一场景里的第二个模型用，如散布花草）：
 *   register = false：不登记材质注册表 / 发射点（否则会顶掉主环境模型的）；config.materials 覆盖照样生效（按材质名）
 *   castShadow：按 mesh 决定是否投阴影（默认全部投）
 */
export function useEnvMaterials(
  sceneId: SceneId,
  root: Object3D,
  options: { register?: boolean; castShadow?: (mesh: Mesh) => boolean } = {},
) {
  const register = options.register ?? true
  const castShadowRef = useRef(options.castShadow)
  castShadowRef.current = options.castShadow
  const collected = useMemo(() => collect(root), [root])
  const overrides = useSceneCfg((c) => c.materials)
  const cfg = useSceneCfg((c) => c)
  const tier = useTier()
  const waterEnabled = waterOn(cfg)
  // 生成地形开启时隐藏被替换的原始地形（素材本身不动，关掉 terrain.enabled 即换回）
  const replaced = cfg.terrain.enabled && cfg.terrain.model ? cfg.terrain.replaces : ''

  // 角色表的字符串 key：只有角色变化时才重建材质
  const roles = useMemo(() => {
    const r: Record<string, MaterialRole> = {}
    for (const c of collected) r[c.name] = overrides[c.name]?.role ?? defaultRole(c.name)
    return r
  }, [collected, overrides])
  const rolesKey = JSON.stringify(roles)
  const pondMaterial = cfg.pond.material
  const stiffness = cfg.wind.stiffnessSource
  const thickness = cfg.sss.thicknessSource

  // 渲染阶段只生成材质（不碰场景）；替换 / 还原都在下面的 layout effect 里做，保证先还原旧的再挂新的
  const plan = useMemo(() => {
    const entries: Record<string, MaterialEntry> = {}
    const emitters: [number, number, number][] = []
    /** 每个 mesh 要挂的材质 / 深度材质 / 图层 / 可见性 */
    const assign: Array<{ mesh: Mesh; material: Material; depth?: Material; layer: number; visible: boolean; castShadow?: boolean }> = []
    const created: Material[] = []
    const hidden = new Set(replaced.split(',').map((s) => s.trim()).filter(Boolean))

    for (const c of collected) {
      const role = roles[c.name]
      const src = c.sources[0] as MeshStandardMaterial
      let active: Material[] = c.sources
      box.makeEmpty()
      for (const mesh of c.meshes) box.expandByObject(mesh)
      box.getSize(size)

      if (role === 'vegetation') {
        const m = createVegetationMaterial(src)
        const depth = vegetationDepthMaterial(src)
        created.push(m, depth)
        for (const mesh of c.meshes) {
          bakeVegetationAttributes(mesh, stiffness, thickness)
          assign.push({ mesh, material: m, depth, layer: LAYER_VEGETATION, visible: true })
        }
        active = [m]
      } else if (role === 'crystal') {
        const m = createCrystalMaterial(src)
        created.push(m)
        for (const mesh of c.meshes) assign.push({ mesh, material: m, layer: 0, visible: true })
        active = [m]
      } else if (role === 'bubble') {
        const m = createBubbleMaterial(src)
        created.push(m)
        for (const mesh of c.meshes) {
          bakeBubblePhase(mesh)
          // 阴影深度材质不跟着浮动，透明薄膜也不该投实心影子
          assign.push({ mesh, material: m, layer: 0, visible: true, castShadow: false })
        }
        active = [m]
      } else if (role === 'emitter') {
        c.meshes.forEach((mesh, i) => {
          box.setFromObject(mesh).getCenter(center)
          emitters.push([center.x, center.y, center.z])
          assign.push({ mesh, material: c.originals[i], layer: 0, visible: false })
        })
      } else if (role === 'water') {
        // 水面由 Water.tsx 的平面统一渲染；关闭水面时保留模型自带的水
        c.meshes.forEach((mesh, i) => assign.push({ mesh, material: c.originals[i], layer: 0, visible: !waterEnabled }))
      } else {
        // 静态：水下地形投射焦散（uniform 控制开关，未开水面时不生效）
        for (const s of c.sources) {
          patchCaustics(s)
          // 细节贴图：只给地形类材质叠（草地细节贴到石头上不对）
          // 必须在 pond 之前注册，否则 detail 的代码会排在 pond 之前，读不到水面遮罩
          if (isTerrainName(c.name)) patchDetail(s)
          // 贴图池塘：只给画有池塘的那张地形材质打补丁（开关由 uniform 控制）
          if (c.name === pondMaterial) patchPond(s)
        }
        const visible = !hidden.has(c.name)
        c.meshes.forEach((mesh, i) => assign.push({ mesh, material: c.originals[i], layer: 0, visible }))
      }

      entries[c.name] = {
        name: c.name,
        sources: c.sources as MeshStandardMaterial[],
        active: active as MeshStandardMaterial[],
        meshes: c.meshes,
        meshNames: [...new Set(c.meshes.map((m) => m.name).filter(Boolean))],
        physical: active.some((m) => isPhysical(m)),
        role,
        original: snapshot(src, defaultRole(c.name)),
        size: Math.max(size.x, size.y, size.z),
      }
    }
    return { entries, emitters, assign, created }
    // rolesKey 代表 roles 的内容
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collected, rolesKey, stiffness, thickness, waterEnabled, pondMaterial, replaced])
  const entries = plan.entries

  useLayoutEffect(() => {
    const originals = plan.assign.map((a) => ({ mesh: a.mesh, material: a.mesh.material as Material }))
    for (const a of plan.assign) {
      a.mesh.material = a.material
      a.mesh.customDepthMaterial = a.depth
      a.mesh.layers.set(a.layer)
      a.mesh.visible = a.visible
      a.mesh.castShadow = a.castShadow ?? castShadowRef.current?.(a.mesh) ?? true
      a.mesh.receiveShadow = true
    }
    if (register) {
      useModelEmitters.setState({ positions: plan.emitters })
      useMaterialRegistry.setState({ scene: sceneId, entries: plan.entries })
    }
    return () => {
      for (const o of originals) {
        o.mesh.material = o.material
        o.mesh.customDepthMaterial = undefined
        o.mesh.layers.set(0)
        o.mesh.visible = true
      }
      for (const m of plan.created) m.dispose()
      if (!register) return
      if (useMaterialRegistry.getState().entries === plan.entries) useMaterialRegistry.setState({ scene: null, entries: {} })
      useModelEmitters.setState({ positions: [] })
    }
  }, [plan, sceneId, register])

  // 数值：原值 ← 角色基础值 ← 面板覆盖
  useEffect(() => {
    for (const e of Object.values(entries)) {
      applyValues(e.active, { ...e.original, ...roleBase(e, cfg, tier), ...overrides[e.name], role: e.role })
      if (e.role === 'bubble') for (const m of e.active) applyBubbleValues(m, cfg.bubble)
    }
  }, [entries, overrides, cfg, tier])
}
