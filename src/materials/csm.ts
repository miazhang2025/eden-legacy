import { MeshPhysicalMaterial, MeshStandardMaterial, type Material } from 'three'
import CustomShaderMaterial from 'three-custom-shader-material/vanilla'

// CSM 封装（spec §5.2）：在 MeshStandard / MeshPhysical 基础上注入自定义 vertex/fragment，保留 three 的光照与 IBL。
// 从模型原材质复制贴图与数值，再包一层 CSM。

export type EdenCSM = MeshStandardMaterial & { __edenRole?: string }

type Uniforms = Record<string, { value: unknown }>

export function createCSM(
  kind: 'standard' | 'physical',
  source: Material,
  shaders: { vertexShader?: string; fragmentShader?: string; uniforms: Uniforms; cacheKey: string },
): EdenCSM {
  const base = kind === 'physical' ? new MeshPhysicalMaterial() : new MeshStandardMaterial()
  // Standard 的 copy 只读 standard 字段，源是 standard 或 physical 都安全
  MeshStandardMaterial.prototype.copy.call(base, source as MeshStandardMaterial)
  if (kind === 'physical' && (source as MeshPhysicalMaterial).isMeshPhysicalMaterial) base.copy(source as MeshPhysicalMaterial)
  // Standard 的 copy 会把 defines 重置为 { STANDARD }，physical 必须补回 PHYSICAL，否则 transmission 等分支编译失败
  if (kind === 'physical') base.defines = { STANDARD: '', PHYSICAL: '' }
  base.name = source.name
  const m = new CustomShaderMaterial({
    baseMaterial: base,
    vertexShader: shaders.vertexShader,
    fragmentShader: shaders.fragmentShader,
    uniforms: shaders.uniforms,
    cacheKey: () => shaders.cacheKey,
  }) as unknown as EdenCSM
  m.name = source.name
  return m
}
