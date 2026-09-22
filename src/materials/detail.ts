import { RepeatWrapping, SRGBColorSpace, TextureLoader, Vector2, type Material, type Texture } from 'three'
import type { SceneConfig, TierSettings } from '../config/schema'
import { terrainGlobals } from './terrainGlobals'

// 地形细节贴图（detail map）：美术的地形贴图分辨率摊到几十米上每像素很糊，
// 近处叠一层平铺的草地细节（颜色 + 法线），远处按距离淡出，避免整片地面出现平铺花纹。
// 投影用世界 XZ 平面（地形基本是水平的），陡坡按法线 y 权重淡出。

const url = (path: string) => `${import.meta.env.BASE_URL}${path.replace(/^\//, '')}`

const loader = new TextureLoader()
const cache = new Map<string, Texture>()

function load(path: string, srgb: boolean) {
  const key = `${path}|${srgb}`
  let tex = cache.get(key)
  if (!tex) {
    tex = loader.load(url(path))
    tex.wrapS = tex.wrapT = RepeatWrapping
    if (srgb) tex.colorSpace = SRGBColorSpace
    cache.set(key, tex)
  }
  return tex
}

export const detailUniforms = {
  uDetailEnabled: { value: 0 },
  uDetailMap: { value: null as Texture | null },
  uDetailNormalMap: { value: null as Texture | null },
  uDetailHasNormal: { value: 0 },
  /** 平铺尺度：世界坐标 × scale 作为 uv */
  uDetailScale: { value: new Vector2(0.5, 0.5) },
  uDetailStrength: { value: 0.5 },
  uDetailNormalStrength: { value: 0.6 },
  /** 距离淡出：相机到片元的距离，start 之前全强度，end 之后为 0 */
  uDetailFadeStart: { value: 8 },
  uDetailFadeEnd: { value: 35 },
  /** 坡面淡出：法线越竖直（墙面）细节越弱，避免拉伸 */
  uDetailSlopeFade: { value: 0.6 },
  /** 打散平铺重复：再采一次旋转 + 缩小的 uv 混合，0 = 关闭（省两次采样） */
  uDetailBreakup: { value: 0.5 },
}

export function updateDetailUniforms(cfg: SceneConfig, tier: TierSettings) {
  const d = cfg.detail
  const u = detailUniforms
  // 档位：low 直接关（地形是屏幕上面积最大的片元）
  const on = d.enabled && d.map !== '' && tier.detail !== 'off'
  u.uDetailEnabled.value = on ? 1 : 0
  if (!on) return
  u.uDetailMap.value = load(d.map, true)
  u.uDetailNormalMap.value = d.normalMap ? load(d.normalMap, false) : null
  u.uDetailHasNormal.value = d.normalMap ? 1 : 0
  u.uDetailScale.value.set(d.scale, d.scale)
  u.uDetailStrength.value = d.strength
  u.uDetailNormalStrength.value = d.normalStrength
  u.uDetailFadeStart.value = d.fadeStart
  u.uDetailFadeEnd.value = Math.max(d.fadeEnd, d.fadeStart + 0.01)
  u.uDetailSlopeFade.value = d.slopeFade
  // mid 档不做打散（省两次纹理采样），代价是近处能看出平铺
  u.uDetailBreakup.value = tier.detail === 'full' ? d.breakup : 0
}

/** 哪些材质算地形（材质名来自贴图文件名，如 SC08_land） */
const TERRAIN = /land|landscape|ground|terrain/i
export const isTerrainName = (name: string) => TERRAIN.test(name)

const PATCHED = Symbol('eden-detail')

const header = /* glsl */ `
uniform float uDetailEnabled;
uniform sampler2D uDetailMap;
uniform sampler2D uDetailNormalMap;
uniform float uDetailHasNormal;
uniform vec2 uDetailScale;
uniform float uDetailStrength;
uniform float uDetailNormalStrength;
uniform float uDetailFadeStart;
uniform float uDetailFadeEnd;
uniform float uDetailSlopeFade;
uniform float uDetailBreakup;
varying vec3 vEdenDetailPos;
varying vec3 vEdenDetailNormal;
vec2 edenDetailUv2 = vec2(0.0);

/** 两套 uv 混合，抵消单一平铺的重复感 */
vec3 edenDetailSample(sampler2D tex) {
  vec3 a = texture2D(tex, edenDetailUv).rgb;
  if (uDetailBreakup < 0.001) return a;
  vec3 b = texture2D(tex, edenDetailUv2).rgb;
  return mix(a, b, uDetailBreakup * 0.5);
}
`

/** 给地形类材质叠加细节贴图。是否生效由 uniform 控制，不需要重新编译。 */
export function patchDetail(material: Material) {
  const m = material as Material & { [PATCHED]?: true }
  if (m[PATCHED]) return
  m[PATCHED] = true
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader, renderer) => {
    prev?.call(m, shader, renderer)
    Object.assign(shader.uniforms, detailUniforms)
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vEdenDetailPos;\nvarying vec3 vEdenDetailNormal;')
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vEdenDetailPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vEdenDetailNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      )
    shader.fragmentShader = shader.fragmentShader
      // 全局变量要先于 header 声明：header 里的 edenDetailSample 会用到 edenDetailUv
      .replace('#include <common>', `#include <common>\n${terrainGlobals(shader.fragmentShader)}\n${header}`)
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
        if (uDetailEnabled > 0.5) {
          float dist = distance(cameraPosition, vEdenDetailPos);
          float byDist = 1.0 - smoothstep(uDetailFadeStart, uDetailFadeEnd, dist);
          // 陡坡上 XZ 投影会被拉伸，按朝上程度淡出
          float bySlope = mix(1.0, smoothstep(0.0, 1.0, abs(vEdenDetailNormal.y)), uDetailSlopeFade);
          // 池塘水面不叠草地细节（pond 补丁先执行，这里 edenPondMask 已经算好了）
          edenDetailFade = byDist * bySlope * (1.0 - edenPondMask);
          edenDetailUv = vEdenDetailPos.xz * uDetailScale;
          // 第二套 uv：旋转约 37° 再缩小，两者的重复周期不同，叠在一起看不出平铺
          vec2 rot = vec2(vEdenDetailPos.x * 0.8 - vEdenDetailPos.z * 0.6, vEdenDetailPos.x * 0.6 + vEdenDetailPos.z * 0.8);
          edenDetailUv2 = rot * uDetailScale * 0.37;
          if (edenDetailFade > 0.001) {
            vec3 d = edenDetailSample(uDetailMap);
            // 叠加而不是替换：detail 的中灰保持原色不变
            diffuseColor.rgb *= mix(vec3(1.0), d * 2.0, uDetailStrength * edenDetailFade);
          }
        }`,
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        if (edenDetailFade > 0.001 && uDetailHasNormal > 0.5) {
          vec3 dn = edenDetailSample(uDetailNormalMap) * 2.0 - 1.0;
          float s = uDetailNormalStrength * edenDetailFade;
          // XZ 平面投影：切线空间的 x/y 对应世界的 x/z，只加扰动、不替换原法线
          vec3 dnW = vec3(dn.x, 0.0, -dn.y) * s;
          normal = normalize(normal + (viewMatrix * vec4(dnW, 0.0)).xyz);
        }`,
      )
  }
  const prevKey = m.customProgramCacheKey?.bind(m)
  m.customProgramCacheKey = () => `${prevKey?.() ?? ''}|eden-detail`
  m.needsUpdate = true
}
