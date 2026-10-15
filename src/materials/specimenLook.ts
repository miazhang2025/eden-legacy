import { Color, Vector3, type Material, type MeshStandardMaterial } from 'three'
import type { GlobalConfig } from '../config/schema'

// 标本影棚光：交互资产（场景里 + 结尾标本盒里）统一用一套固定在镜头空间的中性灯光着色，
// 颜色接近美术效果图（中性影棚渲染），不随各场景的有色灯光、曝光变化。
//   影棚着色 = 底色 × (环境 + 主光 + 补光 + 轮廓) + 高光，再除以当前曝光（色调映射前抵消 render.exposure）
//   最终 = mix(场景光照, 影棚着色, mix) + 自发光（自发光同样按 mix 抵消曝光，场景里的呼吸 / 选中发光照常）
// 只补 MeshStandard / Physical 材质（unlit 的材质本来就是底色）。
// 另外每个资产可以单独调色（data/assets.ts 的 specimenGrade：色相 / 饱和度 / 亮度）对齐效果图；
// 没有自发光贴图时自发光 = emissive × 调色后的底色。

export const specimenUniforms = {
  uSpecMix: { value: 0 },
  uSpecGain: { value: 1 },
  uSpecAmbient: { value: 0.5 },
  uSpecKey: { value: 0.6 },
  uSpecFill: { value: 0.25 },
  uSpecRim: { value: 0.2 },
  uSpecSpec: { value: 0.3 },
  uSpecKeyColor: { value: new Color() },
  uSpecFillColor: { value: new Color() },
  uSpecSaturation: { value: 1 },
  uSpecExposure: { value: 1 },
  /** 镜头空间的主光 / 补光方向：左上前方主光，右侧补光 */
  uSpecKeyDir: { value: new Vector3(-0.5, 0.7, 0.6).normalize() },
  uSpecFillDir: { value: new Vector3(0.7, -0.1, 0.7).normalize() },
}

export function updateSpecimenUniforms(cfg: GlobalConfig['specimenLook'], exposure: number) {
  const u = specimenUniforms
  u.uSpecMix.value = cfg.enabled ? cfg.mix : 0
  u.uSpecGain.value = cfg.gain
  u.uSpecAmbient.value = cfg.ambient
  u.uSpecKey.value = cfg.key
  u.uSpecFill.value = cfg.fill
  u.uSpecRim.value = cfg.rim
  u.uSpecSpec.value = cfg.spec
  u.uSpecKeyColor.value.set(cfg.keyColor)
  u.uSpecFillColor.value.set(cfg.fillColor)
  u.uSpecSaturation.value = cfg.saturation
  u.uSpecExposure.value = exposure || 1
}

const header = /* glsl */ `
uniform float uSpecMix;
uniform float uSpecGain;
uniform float uSpecAmbient;
uniform float uSpecKey;
uniform float uSpecFill;
uniform float uSpecRim;
uniform float uSpecSpec;
uniform vec3 uSpecKeyColor;
uniform vec3 uSpecFillColor;
uniform float uSpecSaturation;
uniform float uSpecExposure;
uniform vec3 uSpecKeyDir;
uniform vec3 uSpecFillDir;
uniform float uSpecHue;
uniform float uSpecHueCenter;
uniform float uSpecHueWidth;
uniform float uSpecSat;
uniform float uSpecBright;
`

const shade = /* glsl */ `
if (uSpecMix > 0.0) {
  // normal / vViewPosition 都在镜头空间；normal 已按正反面翻转
  vec3 sN = normalize(normal);
  vec3 sV = normalize(vViewPosition);
  float sKey = max(dot(sN, uSpecKeyDir), 0.0);
  float sFill = max(dot(sN, uSpecFillDir), 0.0);
  float sRim = pow(1.0 - max(dot(sN, sV), 0.0), 3.0);
  float sGloss = 1.0 - clamp(roughnessFactor, 0.0, 1.0);
  float sSpec = pow(max(dot(sN, normalize(uSpecKeyDir + sV)), 0.0), mix(8.0, 80.0, sGloss)) * sGloss;
  vec3 sLight = vec3(uSpecAmbient) + uSpecKeyColor * (uSpecKey * sKey) + uSpecFillColor * (uSpecFill * sFill) + vec3(uSpecRim * sRim);
  vec3 sAlbedo = diffuseColor.rgb;
  float sLum = dot(sAlbedo, vec3(0.2126, 0.7152, 0.0722));
  sAlbedo = max(mix(vec3(sLum), sAlbedo, uSpecSaturation), 0.0);
  vec3 sStudio = (sAlbedo * sLight + uSpecKeyColor * (uSpecSpec * sSpec)) * uSpecGain / uSpecExposure;
  vec3 sLit = outgoingLight - totalEmissiveRadiance;
  outgoingLight = mix(sLit, sStudio, uSpecMix) + totalEmissiveRadiance * mix(1.0, 1.0 / uSpecExposure, uSpecMix);
}
`

/** 单个资产的调色：hue 度，saturation / brightness 为倍数 */
export interface SpecimenGrade {
  hue?: number
  /** 只转这一段色相（中心，度）；不填 = 整体转 */
  hueCenter?: number
  /** 选择范围的半宽（度），边缘柔和过渡 */
  hueWidth?: number
  saturation?: number
  brightness?: number
}

// 色相旋转（绕灰轴；可只转 hueCenter ± hueWidth 那一段，按色相距离柔和衰减），再调饱和度、亮度
const grade = /* glsl */ `
{
  vec3 gC = diffuseColor.rgb;
  float gAngle = uSpecHue;
  if (uSpecHueWidth > 0.0) {
    // RGB → 色相（弧度）
    float gMax = max(gC.r, max(gC.g, gC.b));
    float gMin = min(gC.r, min(gC.g, gC.b));
    float gD = gMax - gMin;
    float gH = 0.0;
    if (gD > 1e-5) {
      if (gMax == gC.r) gH = mod((gC.g - gC.b) / gD, 6.0);
      else if (gMax == gC.g) gH = (gC.b - gC.r) / gD + 2.0;
      else gH = (gC.r - gC.g) / gD + 4.0;
    }
    gH *= 1.0471976;
    float gDist = abs(mod(gH - uSpecHueCenter + 3.1415927, 6.2831853) - 3.1415927);
    // 越灰越不转（灰色没有可靠的色相）
    gAngle *= (1.0 - smoothstep(uSpecHueWidth * 0.6, uSpecHueWidth, gDist)) * smoothstep(0.02, 0.12, gD / max(gMax, 1e-5));
  }
  float gCos = cos(gAngle);
  float gSin = sin(gAngle);
  vec3 gK = vec3(0.57735);
  gC = gC * gCos + cross(gK, gC) * gSin + gK * dot(gK, gC) * (1.0 - gCos);
  float gLum = dot(gC, vec3(0.2126, 0.7152, 0.0722));
  gC = mix(vec3(gLum), gC, uSpecSat) * uSpecBright;
  diffuseColor.rgb = max(gC, 0.0);
}
`

// 没有自发光贴图时，自发光按（调色后的）底色走：场景里资产按自己的颜色发光
const glow = /* glsl */ `
#ifndef USE_EMISSIVEMAP
totalEmissiveRadiance *= diffuseColor.rgb;
#endif
`

const PATCHED = Symbol('eden-specimen')
const DEG = Math.PI / 180

export function patchSpecimenLook(material: Material, g: SpecimenGrade = {}) {
  const m = material as MeshStandardMaterial & { [PATCHED]?: true }
  if (!m.isMeshStandardMaterial || m[PATCHED]) return
  m[PATCHED] = true
  // 每个材质自己的调色 uniform（影棚光参数是全局共享的）
  const own = {
    uSpecHue: { value: (g.hue ?? 0) * DEG },
    uSpecHueCenter: { value: (g.hueCenter ?? 0) * DEG },
    uSpecHueWidth: { value: g.hueCenter === undefined ? 0 : (g.hueWidth ?? 40) * DEG },
    uSpecSat: { value: g.saturation ?? 1 },
    uSpecBright: { value: g.brightness ?? 1 },
  }
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader, renderer) => {
    prev?.call(m, shader, renderer)
    Object.assign(shader.uniforms, specimenUniforms, own)
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>\n${header}`)
      .replace('#include <map_fragment>', `#include <map_fragment>\n${grade}`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>\n${glow}`)
      .replace('#include <opaque_fragment>', `${shade}\n#include <opaque_fragment>`)
  }
  const prevKey = m.customProgramCacheKey?.bind(m)
  m.customProgramCacheKey = () => `${prevKey?.() ?? ''}|eden-specimen`
  m.needsUpdate = true
}
