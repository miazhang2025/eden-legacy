import {
  BackSide,
  DoubleSide,
  FrontSide,
  type Material,
  type Mesh,
  type MeshPhysicalMaterial,
  type MeshStandardMaterial,
  type Side,
} from 'three'
import { create } from 'zustand'
import type { MaterialOverride, MaterialRole, MaterialSide, SceneId } from '../config/schema'

// 材质注册表 + 覆盖应用（spec §9.3 Materials）。
// 启动时遍历场景收集所有唯一 material name；config.materials 按 name 覆盖字段，未出现的保持模型自带值。
// 角色转换（植被 / 晶体 / 水 / 发射点）见 envMaterials.ts。

export interface MaterialEntry {
  name: string
  /** 模型原材质（glTF 导出的 MeshStandard / MeshPhysical） */
  sources: MeshStandardMaterial[]
  /** 当前实际渲染用的材质（静态 = 原材质；其它角色 = 自定义 CSM） */
  active: MeshStandardMaterial[]
  meshes: Mesh[]
  /** 使用该材质的 mesh 名（面板里「按 mesh 定位」用） */
  meshNames: string[]
  /** 当前材质是否为 MeshPhysicalMaterial（决定面板显示哪些字段） */
  physical: boolean
  role: MaterialRole
  /** 模型自带的原值，用于回退与导出时做 diff */
  original: Required<MaterialOverride>
  /** 包围盒最长边（晶体主体 / 次级判定） */
  size: number
}

interface RegistryState {
  scene: SceneId | null
  entries: Record<string, MaterialEntry>
}

export const useMaterialRegistry = create<RegistryState>()(() => ({ scene: null, entries: {} }))

const SIDE_TO_THREE: Record<MaterialSide, Side> = { front: FrontSide, back: BackSide, double: DoubleSide }
const sideName = (s: Side): MaterialSide => (s === BackSide ? 'back' : s === DoubleSide ? 'double' : 'front')
export const isStandard = (m: Material): m is MeshStandardMaterial =>
  (m as MeshStandardMaterial).isMeshStandardMaterial === true
export const isPhysical = (m: Material): m is MeshPhysicalMaterial =>
  (m as MeshPhysicalMaterial).isMeshPhysicalMaterial === true

/** 植被类关键词（材质名来自贴图文件名，如 SC25_Coral、SC16_lupin） */
const VEGETATION = /poppy|daisy|lupin|pineapple|tree|hydrangea|lotus|archangel|arrowhead|snakeplant|stem|bud|coral|anemone|grass|plant|flower|leaf|weed/i
const CRYSTAL = /crystal|bubble|shell|pearl|droplet/i
const STATIC = /land|landscape|rock|pepple|pebble|stone|ground/i

/**
 * 推断材质角色。优先前缀约定（veg_ / crystal_ / water_ / emitter_），
 * 其次按材质名里的用途关键词（美术把贴图命名为 SC08_land、SC25_Coral 这种，能直接对上）。
 * 认不出来的一律当静态，避免不该动的东西跟着风摆。
 */
export function defaultRole(name: string): MaterialRole {
  const n = name.toLowerCase()
  if (n.startsWith('veg_')) return 'vegetation'
  if (n.startsWith('crystal_')) return 'crystal'
  if (n.startsWith('water_')) return 'water'
  if (n.startsWith('emitter_')) return 'emitter'
  if (n.includes('水') || /water/i.test(n)) return 'water'
  if (STATIC.test(n)) return 'static'
  if (CRYSTAL.test(n)) return 'crystal'
  if (VEGETATION.test(n)) return 'vegetation'
  return 'static'
}

export function snapshot(m: MeshStandardMaterial, role: MaterialRole): Required<MaterialOverride> {
  const p = isPhysical(m) ? m : null
  return {
    role,
    color: `#${m.color.getHexString()}`,
    roughness: m.roughness,
    metalness: m.metalness,
    emissive: `#${m.emissive.getHexString()}`,
    emissiveIntensity: m.emissiveIntensity,
    envMapIntensity: m.envMapIntensity,
    normalScale: m.normalScale.x,
    opacity: m.opacity,
    transparent: m.transparent,
    alphaTest: m.alphaTest,
    side: sideName(m.side),
    wireframe: m.wireframe,
    clearcoat: p?.clearcoat ?? 0,
    transmission: p?.transmission ?? 0,
    ior: p?.ior ?? 1.5,
    thickness: p?.thickness ?? 0,
    attenuationColor: p ? `#${p.attenuationColor.getHexString()}` : '#ffffff',
  }
}

/** 把数值写到材质上（role 字段不在这里处理） */
export function applyValues(materials: MeshStandardMaterial[], v: Required<MaterialOverride>) {
  for (const m of materials) {
    const side = SIDE_TO_THREE[v.side]
    let needsUpdate = m.transparent !== v.transparent || m.alphaTest !== v.alphaTest || m.side !== side
    m.color.set(v.color)
    m.roughness = v.roughness
    m.metalness = v.metalness
    m.emissive.set(v.emissive)
    m.emissiveIntensity = v.emissiveIntensity
    m.envMapIntensity = v.envMapIntensity
    m.normalScale.set(v.normalScale, v.normalScale)
    m.opacity = v.opacity
    m.transparent = v.transparent
    m.alphaTest = v.alphaTest
    m.side = side
    m.wireframe = v.wireframe
    if (isPhysical(m)) {
      // transmission 从 0 变为非 0 会切换 shader 分支，需要重新编译
      if ((m.transmission > 0) !== (v.transmission > 0)) needsUpdate = true
      m.clearcoat = v.clearcoat
      m.transmission = v.transmission
      m.ior = v.ior
      m.thickness = v.thickness
      m.attenuationColor.set(v.attenuationColor)
    }
    if (needsUpdate) m.needsUpdate = true
  }
}

// DEV：暴露给自动化测试脚本
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__materialRegistry = useMaterialRegistry
