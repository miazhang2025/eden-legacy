import { Color, ShaderMaterial, Vector3, type Material, type Texture } from 'three'
import type { GroundLayer, SceneConfig } from '../config/schema'
import noise from './chunks/noise.glsl?raw'
import { terrainGlobals } from './terrainGlobals'

// 生成地形的表面（scripts/build-terrain.mjs）。顶点色不当颜色乘，而是当遮罩读：
//   r = 原地形范围（1 = 中心，边缘向外渐变到 0 = 远景裙边）
//   g = 水域（池底着色）
//   b = 离原地形边缘的距离 ÷ FAR_DIST（裙边用）
// textured：中心用 near 一套、裙边用 far 一套（Megascans 平铺：颜色 / 法线 / ORM），按 r 混合；
// painted ：中心颜色换成原地形的手绘贴图 × near.tint × paintBrightness（法线、粗糙度仍用 near）。
// farMatch（painted）：裙边颜色从岛边的手绘贴图（模糊 mip）按距离渐变到 deepColor，far 贴图只提供明暗细节，岛边接缝看不出来。
// 平铺 uv = 世界 XZ ÷ tileSize；颜色再混一套旋转缩小的 uv、叠大尺度明暗，远看不出平铺周期。

const layerUniforms = () => ({
  albedo: { value: null as Texture | null },
  normal: { value: null as Texture | null },
  orm: { value: null as Texture | null },
  /** 1 / tileSize */
  scale: { value: 1 },
  tint: { value: new Color(1, 1, 1) },
  normalStrength: { value: 1 },
  aoStrength: { value: 0.8 },
  roughness: { value: 1 },
})
type LayerUniforms = ReturnType<typeof layerUniforms>

const near = layerUniforms()
const far = layerUniforms()

export const terrainUniforms = {
  uTerrainMode: { value: 0 },
  uTerrainPaint: { value: null as Texture | null },
  uTerrainPaintGain: { value: 1 },
  /** painted 时近处法线 / ORM 的梯度放大倍数（2^模糊级数） */
  uTerrainPaintBlur: { value: 1 },
  uNearAlbedo: near.albedo,
  uNearNormal: near.normal,
  uNearOrm: near.orm,
  uNearScale: near.scale,
  uNearTint: near.tint,
  uNearNormalStrength: near.normalStrength,
  uNearAO: near.aoStrength,
  uNearRough: near.roughness,
  uFarAlbedo: far.albedo,
  uFarNormal: far.normal,
  uFarOrm: far.orm,
  uFarScale: far.scale,
  uFarTint: far.tint,
  uFarNormalStrength: far.normalStrength,
  uFarAO: far.aoStrength,
  uFarRough: far.roughness,
  uTerrainBreakup: { value: 0.5 },
  uTerrainMacro: { value: 0.25 },
  uTerrainMacroScale: { value: 1 / 18 },
  uTerrainBed: { value: new Color() },
  uTerrainBedTint: { value: 0.5 },
  uFarMatch: { value: 0 },
  uFarEdge: { value: new Color() },
  uFarDeep: { value: new Color() },
  uFarStart: { value: 0 },
  uFarEnd: { value: 40 },
  uFarDetail: { value: 1 },
  uFarPaintMip: { value: 5 },
  uFarPaintReach: { value: 4 },
}

/** 贴图由 GeneratedTerrain 加载后塞进来 */
export function setTerrainTextures(
  t: { near: [Texture, Texture, Texture]; far: [Texture, Texture, Texture]; paint: Texture | null } | null,
) {
  for (const [u, set] of [
    [near, t?.near],
    [far, t?.far],
  ] as const) {
    u.albedo.value = set?.[0] ?? null
    u.normal.value = set?.[1] ?? null
    u.orm.value = set?.[2] ?? null
  }
  terrainUniforms.uTerrainPaint.value = t?.paint ?? null
}

function updateLayer(u: LayerUniforms, c: GroundLayer) {
  u.scale.value = 1 / Math.max(0.01, c.tileSize)
  u.tint.value.set(c.tint)
  u.normalStrength.value = c.normalStrength
  u.aoStrength.value = c.aoStrength
  u.roughness.value = c.roughness
}

export function updateTerrainUniforms(cfg: SceneConfig) {
  const t = cfg.terrain
  const u = terrainUniforms
  u.uTerrainMode.value = t.material === 'painted' ? 1 : 0
  u.uTerrainPaintGain.value = t.paintBrightness
  u.uTerrainPaintBlur.value = t.material === 'painted' ? 2 ** t.paintNormalBlur : 1
  updateLayer(near, t.near)
  updateLayer(far, t.far)
  u.uTerrainBreakup.value = t.breakup
  u.uTerrainMacro.value = t.macroStrength
  u.uTerrainMacroScale.value = 1 / Math.max(0.1, t.macroScale)
  u.uTerrainBed.value.set(t.bedColor)
  u.uTerrainBedTint.value = t.bedTint
  const fm = t.farMatch
  u.uFarMatch.value = t.material === 'painted' && fm?.enabled ? 1 : 0
  if (fm) {
    u.uFarEdge.value.set(fm.edgeColor)
    u.uFarDeep.value.set(fm.deepColor)
    u.uFarStart.value = fm.start
    u.uFarEnd.value = Math.max(fm.start + 0.1, fm.end)
    u.uFarDetail.value = fm.detail
    u.uFarPaintMip.value = fm.paintMip
    u.uFarPaintReach.value = Math.max(0.1, fm.paintReach)
  }
}

/** 顶点色 b 的量程（米），与 scripts/build-terrain.mjs 的 FAR_DIST 一致 */
const FAR_DIST = 128

const PATCHED = Symbol('eden-terrain')

const header = /* glsl */ `
uniform float uTerrainMode;
uniform sampler2D uTerrainPaint;
uniform float uTerrainPaintGain;
uniform float uTerrainPaintBlur;
uniform sampler2D uNearAlbedo;
uniform sampler2D uNearNormal;
uniform sampler2D uNearOrm;
uniform float uNearScale;
uniform vec3 uNearTint;
uniform float uNearNormalStrength;
uniform float uNearAO;
uniform float uNearRough;
uniform sampler2D uFarAlbedo;
uniform sampler2D uFarNormal;
uniform sampler2D uFarOrm;
uniform float uFarScale;
uniform vec3 uFarTint;
uniform float uFarNormalStrength;
uniform float uFarAO;
uniform float uFarRough;
uniform float uTerrainBreakup;
uniform float uTerrainMacro;
uniform float uTerrainMacroScale;
uniform vec3 uTerrainBed;
uniform float uTerrainBedTint;
uniform float uFarMatch;
uniform vec3 uFarEdge;
uniform vec3 uFarDeep;
uniform float uFarStart;
uniform float uFarEnd;
uniform float uFarDetail;
uniform float uFarPaintMip;
uniform float uFarPaintReach;
varying vec4 vEdenTerrainMask;
varying vec3 vEdenTerrainPos;
varying vec3 vEdenTerrainNormal;
varying vec2 vEdenTerrainUv;

// 本补丁在 map / roughness / normal / ao 几处之间传递的结果
vec3 edenGroundNormal = vec3(0.0, 0.0, 1.0);
float edenGroundAO = 1.0;
float edenGroundRough = 1.0;
float edenGroundAOStrength = 0.0;

struct EdenGround { vec3 albedo; vec3 normal; vec3 orm; };

// 贴图采样都在按像素分支里，梯度必须在分支外算好（textureGrad），否则分支交界处 mip 会乱
// blur：法线 / ORM 的梯度放大倍数（> 1 = 取更模糊的 mip）
EdenGround edenSampleGround(sampler2D A, sampler2D N, sampler2D O, vec2 uv, vec2 dx, vec2 dy, vec2 uvB, vec2 dxB, vec2 dyB, float blur) {
  EdenGround g;
  g.albedo = textureGrad(A, uv, dx, dy).rgb;
  if (uTerrainBreakup > 0.001) g.albedo = mix(g.albedo, textureGrad(A, uvB, dxB, dyB).rgb, uTerrainBreakup * 0.5);
  g.normal = textureGrad(N, uv, dx * blur, dy * blur).xyz * 2.0 - 1.0;
  g.orm = textureGrad(O, uv, dx * blur, dy * blur).rgb;
  return g;
}
`

/** 给生成地形的材质打补丁（材质本身不挂 map，颜色全由这里决定） */
export function patchTerrain(material: Material) {
  const m = material as Material & { [PATCHED]?: true }
  if (m[PATCHED]) return
  m[PATCHED] = true
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader, renderer) => {
    prev?.call(m, shader, renderer)
    Object.assign(shader.uniforms, terrainUniforms)
    // vertexColors 关着，three 不会声明 color 属性，这里自己读
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute vec4 color;
        varying vec4 vEdenTerrainMask;
        varying vec3 vEdenTerrainPos;
        varying vec3 vEdenTerrainNormal;
        varying vec2 vEdenTerrainUv;`,
      )
      .replace(
        '#include <project_vertex>',
        `#include <project_vertex>
        vEdenTerrainMask = color;
        vEdenTerrainUv = uv;
        vEdenTerrainPos = (modelMatrix * vec4(transformed, 1.0)).xyz;
        vEdenTerrainNormal = normalize(mat3(modelMatrix) * objectNormal);`,
      )
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>\n${header}\n${terrainGlobals(shader.fragmentShader)}\n${
          shader.fragmentShader.includes('float edenNoise(') ? '' : noise
        }`,
      )
      .replace(
        '#include <map_fragment>',
        /* glsl */ `#include <map_fragment>
        {
          vec3 p = vEdenTerrainPos;
          vec2 rot = vec2(p.x * 0.8 - p.z * 0.6, p.x * 0.6 + p.z * 0.8) * 0.37;
          vec2 uvN = p.xz * uNearScale;
          vec2 uvF = p.xz * uFarScale;
          vec2 uvNB = rot * uNearScale;
          vec2 uvFB = rot * uFarScale;
          vec2 dxN = dFdx(uvN), dyN = dFdy(uvN), dxF = dFdx(uvF), dyF = dFdy(uvF);
          vec2 dxNB = dFdx(uvNB), dyNB = dFdy(uvNB), dxFB = dFdx(uvFB), dyFB = dFdy(uvFB);
          vec2 dxP = dFdx(vEdenTerrainUv), dyP = dFdy(vEdenTerrainUv);
          float w = clamp(vEdenTerrainMask.r, 0.0, 1.0);

          EdenGround g;
          g.albedo = vec3(0.0); g.normal = vec3(0.0); g.orm = vec3(0.0);
          float aoS = 0.0, roughS = 0.0, nS = 0.0;
          if (w > 0.001) {
            EdenGround n = edenSampleGround(uNearAlbedo, uNearNormal, uNearOrm, uvN, dxN, dyN, uvNB, dxNB, dyNB, uTerrainPaintBlur);
            n.albedo *= uNearTint;
            // painted：颜色换成原地形手绘贴图
            if (uTerrainMode > 0.5) n.albedo = textureGrad(uTerrainPaint, vEdenTerrainUv, dxP, dyP).rgb * uNearTint * uTerrainPaintGain;
            g.albedo += n.albedo * w; g.normal += n.normal * w; g.orm += n.orm * w;
            aoS += uNearAO * w; roughS += uNearRough * w; nS += uNearNormalStrength * w;
          }
          if (w < 0.999) {
            EdenGround f = edenSampleGround(uFarAlbedo, uFarNormal, uFarOrm, uvF, dxF, dyF, uvFB, dxFB, dyFB, 1.0);
            float fw = 1.0 - w;
            vec3 fAlbedo = f.albedo * uFarTint;
            if (uFarMatch > 0.5) {
              // 岛边颜色：紧贴岛边取手绘贴图的模糊 mip（覆盖区外是 push-pull 往外延的边缘色），离岛 paintReach 米内渐变到 edgeColor；
              // 按离岛距离渐变（跟着岛的轮廓），贴图范围外的夹边 uv 也一并淡掉，不会拉出条纹、方块
              float dist = vEdenTerrainMask.b * ${FAR_DIST.toFixed(1)};
              vec2 uvOut = max(max(-vEdenTerrainUv, vEdenTerrainUv - 1.0), 0.0);
              float paintW = (1.0 - smoothstep(0.0, uFarPaintReach, dist)) * (1.0 - smoothstep(0.0, 0.05, max(uvOut.x, uvOut.y)));
              vec3 paintBlur = textureLod(uTerrainPaint, clamp(vEdenTerrainUv, vec2(0.001), vec2(0.999)), uFarPaintMip).rgb * uNearTint * uTerrainPaintGain;
              vec3 edgeCol = mix(uFarEdge, paintBlur, paintW);
              vec3 base = mix(edgeCol, uFarDeep, smoothstep(uFarStart, uFarEnd, dist));
              // far 贴图只取明暗：相对整张贴图平均亮度（最小一级 mip）的比例
              vec3 lumW = vec3(0.2126, 0.7152, 0.0722);
              float mean = max(dot(textureLod(uFarAlbedo, vec2(0.5), 12.0).rgb, lumW), 1e-3);
              fAlbedo = base * mix(1.0, dot(f.albedo, lumW) / mean, uFarDetail);
            }
            g.albedo += fAlbedo * fw; g.normal += f.normal * fw; g.orm += f.orm * fw;
            aoS += uFarAO * fw; roughS += uFarRough * fw; nS += uFarNormalStrength * fw;
          }
          // 大尺度明暗：两层噪声，远处看不出贴图周期
          float macro = edenNoise(p.xz * uTerrainMacroScale) * 0.65 + edenNoise(p.xz * uTerrainMacroScale * 3.1 + 7.0) * 0.35;
          g.albedo *= mix(1.0, 0.7 + 0.6 * macro, uTerrainMacro);

          edenPondMask = vEdenTerrainMask.g;
          g.albedo = mix(g.albedo, uTerrainBed, edenPondMask * uTerrainBedTint);
          diffuseColor.rgb = g.albedo;
          edenGroundNormal = vec3(g.normal.xy * nS, g.normal.z);
          edenGroundAO = g.orm.r;
          edenGroundAOStrength = aoS;
          edenGroundRough = g.orm.g * roughS;
        }`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        '#include <roughnessmap_fragment>\nroughnessFactor = clamp(edenGroundRough, 0.04, 1.0);',
      )
      .replace(
        '#include <normal_fragment_maps>',
        /* glsl */ `#include <normal_fragment_maps>
        {
          // XZ 平面投影的切线空间：T = +X，B = cross(N, T)（KTX2 不翻转 y，贴图「上」指向 −Z）
          vec3 N = normalize(vEdenTerrainNormal);
          vec3 T = normalize(vec3(1.0, 0.0, 0.0) - N * N.x);
          vec3 B = cross(N, T);
          vec3 nW = normalize(T * edenGroundNormal.x + B * edenGroundNormal.y + N * max(edenGroundNormal.z, 0.05));
          normal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);
        }`,
      )
      .replace(
        '#include <aomap_fragment>',
        /* glsl */ `#include <aomap_fragment>
        {
          float ao = mix(1.0, edenGroundAO, edenGroundAOStrength);
          reflectedLight.indirectDiffuse *= ao;
          reflectedLight.indirectSpecular *= ao;
        }`,
      )
  }
  const prevKey = m.customProgramCacheKey?.bind(m)
  m.customProgramCacheKey = () => `${prevKey?.() ?? ''}|eden-terrain-v4`
  m.needsUpdate = true
}

// 远景尖峰（参考图背景的石林状山峰）：不吃场景雾，自己按高度从「山脚色」（≈ 雾色）渐变到「峰顶色」，
// 再按主光方向加一点明暗。场景雾到 100m 外几乎全白，普通材质的远山会完全看不见。
export const peakUniforms = {
  uPeakTop: { value: new Color() },
  uPeakBase: { value: new Color() },
  uPeakShade: { value: 0.5 },
  uPeakSunDir: { value: new Vector3(0, 1, 0) },
}

export function updatePeakUniforms(cfg: SceneConfig) {
  const p = cfg.terrain.peaks
  peakUniforms.uPeakTop.value.set(p.topColor)
  peakUniforms.uPeakBase.value.set(p.baseColor)
  peakUniforms.uPeakShade.value = p.shade
  peakUniforms.uPeakSunDir.value.set(...cfg.lights.directional.position).normalize()
}

export function createPeakMaterial() {
  return new ShaderMaterial({
    name: 'generated_peaks',
    uniforms: peakUniforms,
    fog: false,
    vertexShader: /* glsl */ `
      attribute vec4 color;
      varying float vH;
      varying vec3 vN;
      void main() {
        vH = color.r;
        vN = normalize(mat3(modelMatrix) * normal);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: /* glsl */ `
      uniform vec3 uPeakTop;
      uniform vec3 uPeakBase;
      uniform float uPeakShade;
      uniform vec3 uPeakSunDir;
      varying float vH;
      varying vec3 vN;
      void main() {
        vec3 c = mix(uPeakBase, uPeakTop, smoothstep(0.0, 0.85, vH));
        float lambert = dot(normalize(vN), normalize(uPeakSunDir)) * 0.5 + 0.5;
        c *= mix(1.0, 0.72 + 0.4 * lambert, uPeakShade);
        gl_FragColor = vec4(c, 1.0);
        #include <tonemapping_fragment>
        #include <colorspace_fragment>
      }
    `,
  })
}
