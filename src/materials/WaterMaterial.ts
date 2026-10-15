import {
  Color,
  DataTexture,
  DataUtils,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  MeshPhysicalMaterial,
  RedFormat,
  Texture,
  Vector2,
  Vector4,
} from 'three'
import { waterBedHeight, waterBedTargets } from '../scene/collision'
import { createCSM, type EdenCSM } from './csm'
import { shared } from './uniforms'
import noise from './chunks/noise.glsl?raw'

// 水面（spec §5.2C）。按档位：
//   low  ：程序化法线扰动 + 菲涅尔 + envMap 反射（physical 自带）
//   mid  ：+ 平面实时反射（Reflector，降分辨率，只渲染地形图层）+ 按水深的颜色渐变
//   high ：+ 屏幕空间折射（physical transmission）+ 岸边泡沫
// 水深来自一次性烘好的高度图（从碰撞体射线采样），不需要每帧渲染深度图。

/** 高度图里表示「水下没有地形」的深度上限 */
export const MAX_DEPTH = 20

export function createWaterUniforms() {
  return {
    uShallowColor: { value: new Color() },
    uDeepColor: { value: new Color() },
    uDepthFalloff: { value: 1 },
    uNormalScale: { value: 0.4 },
    uNormalStrength: { value: 0.3 },
    uFlowSpeed: { value: 0.1 },
    uFlowDir: { value: new Vector2(1, 0) },
    uWaveAmp: { value: 0.1 },
    uWaveLen: { value: 8 },
    uWaveSpeed: { value: 0.5 },
    uWaveSteep: { value: 0.35 },
    uFresnelPower: { value: 4 },
    uReflectionIntensity: { value: 0.8 },
    uReflectionMap: { value: null as Texture | null },
    uReflectionMatrix: { value: new Matrix4() },
    uUseReflection: { value: 0 },
    uUseDepthColor: { value: 0 },
    uFoamWidth: { value: 0.3 },
    uFoamColor: { value: new Color() },
    uUseFoam: { value: 0 },
    uShoreFade: { value: 0 },
    uOpacity: { value: 0.85 },
    uDepthMap: { value: null as Texture | null },
    /** 高度图覆盖范围：xy = 最小 x/z，zw = 边长 */
    uDepthBounds: { value: new Vector4(0, 0, 1, 1) },
    uMaxDepth: { value: MAX_DEPTH },
    /** 1 = 水深来自网格顶点属性 _depth（生成的池塘水面），0 = 来自高度图 */
    uUseVertexDepth: { value: 0 },
  }
}
export type WaterUniforms = ReturnType<typeof createWaterUniforms>

// 三层 Gerstner 波：高度位移 + 横向位移（越陡浪尖越尖），并给出解析法线
const waveChunk = /* glsl */ `
  uniform float uTime;
  uniform vec2 uFlowDir;
  uniform float uWaveAmp;
  uniform float uWaveLen;
  uniform float uWaveSpeed;
  uniform float uWaveSteep;

  const vec3 EDEN_WAVE_AMP = vec3(1.0, 0.55, 0.3);
  const vec3 EDEN_WAVE_LEN = vec3(1.0, 0.52, 0.27);
  const vec3 EDEN_WAVE_ANG = vec3(0.0, 0.9, -0.7);

  vec2 edenRot(vec2 v, float a) {
    float c = cos(a);
    float s = sin(a);
    return vec2(c * v.x - s * v.y, s * v.x + c * v.y);
  }

  /** 返回世界空间位移；out 为该点的水面法线 */
  vec3 edenWaves(vec2 p, out vec3 normal) {
    vec3 offset = vec3(0.0);
    vec2 slope = vec2(0.0);
    vec2 base = length(uFlowDir) > 1e-4 ? normalize(uFlowDir) : vec2(1.0, 0.0);
    for (int i = 0; i < 3; i++) {
      float amp = uWaveAmp * EDEN_WAVE_AMP[i];
      float len = max(uWaveLen * EDEN_WAVE_LEN[i], 0.05);
      vec2 dir = edenRot(base, EDEN_WAVE_ANG[i]);
      float k = 6.2831853 / len;
      float phase = dot(dir, p) * k - uTime * uWaveSpeed * k;
      offset.y += amp * sin(phase);
      offset.xz += dir * (uWaveSteep * amp * cos(phase));
      slope += dir * (amp * k * cos(phase));
    }
    normal = normalize(vec3(-slope.x, 1.0, -slope.y));
    return offset;
  }
`

const vertexShader = /* glsl */ `
  ${waveChunk}
  uniform mat4 uReflectionMatrix;
  attribute float _depth;
  varying vec3 vEdenWaterWorld;
  varying vec4 vEdenReflCoord;
  varying vec3 vEdenWaveNormal;
  varying float vEdenDepth;
  void main() {
    vEdenDepth = _depth;
    vec3 world = (modelMatrix * vec4(position, 1.0)).xyz;
    vec3 n;
    vec3 offset = edenWaves(world.xz, n);
    world += offset;
    vEdenWaterWorld = world;
    vEdenWaveNormal = n;
    // 世界位移换回本地空间
    csm_Position = position + inverse(mat3(modelMatrix)) * offset;
    // uReflectionMatrix 已在 CPU 端乘好「本网格本地 → Reflector 本地」（见 Water.tsx）
    vEdenReflCoord = uReflectionMatrix * vec4(position, 1.0);
  }
`

const fragmentShader = /* glsl */ `
  uniform float uTime;
  uniform vec3 uShallowColor;
  uniform vec3 uDeepColor;
  uniform float uDepthFalloff;
  uniform float uNormalScale;
  uniform float uNormalStrength;
  uniform float uFlowSpeed;
  uniform vec2 uFlowDir;
  uniform float uFresnelPower;
  uniform float uReflectionIntensity;
  uniform sampler2D uReflectionMap;
  uniform float uUseReflection;
  uniform float uUseDepthColor;
  uniform float uFoamWidth;
  uniform vec3 uFoamColor;
  uniform float uUseFoam;
  uniform float uShoreFade;
  uniform float uOpacity;
  uniform sampler2D uDepthMap;
  uniform vec4 uDepthBounds;
  uniform float uMaxDepth;
  uniform float uUseVertexDepth;
  varying vec3 vEdenWaterWorld;
  varying vec4 vEdenReflCoord;
  varying vec3 vEdenWaveNormal;
  varying float vEdenDepth;
  ${noise}

  float edenWaves(vec2 p, vec2 flow) {
    return edenNoise(p + flow) + 0.5 * edenNoise(p * 2.3 - flow * 1.4) + 0.25 * edenNoise(p * 5.1 + flow * 2.1);
  }

  void main() {
    vec2 flow = uFlowDir * uTime * uFlowSpeed;
    vec2 p = vEdenWaterWorld.xz * uNormalScale;
    float e = 0.15;
    float dx = edenWaves(p + vec2(e, 0.0), flow) - edenWaves(p - vec2(e, 0.0), flow);
    float dz = edenWaves(p + vec2(0.0, e), flow) - edenWaves(p - vec2(0.0, e), flow);
    // 大尺度波浪法线 + 小尺度涟漪法线
    vec3 ripple = vec3(-dx * uNormalStrength, 1.0, -dz * uNormalStrength);
    vec3 nW = normalize(normalize(vEdenWaveNormal) + ripple - vec3(0.0, 1.0, 0.0));
    csm_FragNormal = normalize((viewMatrix * vec4(nW, 0.0)).xyz);

    // 水深：高度图 R = 深度 / uMaxDepth
    vec2 duv = (vEdenWaterWorld.xz - uDepthBounds.xy) / uDepthBounds.zw;
    float depth = uMaxDepth;
    if (uUseVertexDepth > 0.5) {
      depth = vEdenDepth;
    } else if (all(greaterThanEqual(duv, vec2(0.0))) && all(lessThanEqual(duv, vec2(1.0)))) {
      depth = texture2D(uDepthMap, duv).r * uMaxDepth;
    }
    float t = uUseDepthColor > 0.5 ? smoothstep(0.0, uDepthFalloff, depth) : 1.0;
    vec3 col = mix(uShallowColor, uDeepColor, t);

    float foam = 0.0;
    if (uUseFoam > 0.5) {
      foam = (1.0 - smoothstep(0.0, uFoamWidth, depth)) * (0.55 + 0.45 * edenNoise(vEdenWaterWorld.xz * 3.0 + flow * 4.0));
      col = mix(col, uFoamColor, foam);
    }
    // 岸边渐隐：越浅越透明，岸线由水深决定（模糊过的水深图是连续的），不再是地形多边形与水平面硬切出的锯齿
    // 各档位都开（只多一次水深采样）；没有水深数据时 uShoreFade = 0
    float shore = uShoreFade > 0.0 ? smoothstep(0.0, uShoreFade, depth) : 1.0;
    csm_DiffuseColor = vec4(col, mix(uOpacity, 1.0, foam) * shore);

    vec3 V = normalize(cameraPosition - vEdenWaterWorld);
    float fresnel = pow(1.0 - max(dot(nW, V), 0.0), uFresnelPower);
    if (uUseReflection > 0.5) {
      vec4 coord = vEdenReflCoord + vec4(nW.xz * 0.6, 0.0, 0.0);
      vec3 refl = texture2DProj(uReflectionMap, coord).rgb;
      csm_Emissive += refl * fresnel * uReflectionIntensity;
    }
  }
`

export function createWaterMaterial(uniforms: WaterUniforms): EdenCSM {
  // 水面没有模型材质可复制，以一个干净的 physical 材质为源
  const m = createCSM('physical', new MeshPhysicalMaterial({ name: 'eden-water' }), {
    vertexShader,
    fragmentShader,
    uniforms: { uTime: shared.uTime, ...uniforms },
    cacheKey: 'eden-water-v3',
  })
  m.__edenRole = 'water'
  return m
}

/** 水深图每个像素覆盖多少米、单边最多多少像素（泡沫带只有 0.3 米宽，太粗会烘出一格格的方块） */
const DEPTH_TEXEL = 0.1
const DEPTH_MAX_RES = 512

export interface DepthMap {
  texture: DataTexture
  /** 覆盖的世界范围 x0, z0, 宽, 深（给 uDepthBounds） */
  bounds: [number, number, number, number]
}

/** 水面上方多高以内的地形算「岸」（深度 0）；不从天上打射线，免得打到洞顶 */
const SHORE_PROBE = 1.2
/** 烘完后的模糊半径（像素）：碰撞体是一块块三角面，逐像素的命中 / 未命中会在岸边烘出锯齿，模糊成连续过渡 */
const DEPTH_BLUR = 3

/** 可分离盒式模糊（原地，横竖各一遍） */
function boxBlur(src: Float32Array, w: number, h: number, r: number) {
  const tmp = new Float32Array(src.length)
  const n = 2 * r + 1
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0
      for (let k = -r; k <= r; k++) s += src[j * w + Math.min(w - 1, Math.max(0, i + k))]
      tmp[j * w + i] = s / n
    }
  }
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      let s = 0
      for (let k = -r; k <= r; k++) s += tmp[Math.min(h - 1, Math.max(0, j + k)) * w + i]
      src[j * w + i] = s / n
    }
  }
}

/**
 * 烘水深图（一次性，水底见 collision.ts 的 waterBedTargets：渲染模型的地形 mesh，没有时用碰撞体）：在水面高度向下发射线，R = 深度（米，半精度浮点）。
 * - 地形高出水面（岸上）：射线起点在地形下面打不到，单独向上探一小段，命中记为深度 0
 *   （以前记成最大深度，岸边一圈「0 / 最大深度」逐像素交错，泡沫和深浅色烘成马赛克）
 * - 水面以下没有地形（如 ocean 的浮岛之间）记为最大深度
 * 烘完模糊两遍，深浅过渡连续。
 * 只烘 area（水面与场景边界的交集）：水面往往比能走到的范围大得多，烘整片会把分辨率浪费在看不到的地方。
 */
export function bakeDepthMap(level: number, area: [number, number, number, number]): DepthMap {
  const [x0, z0, w, h] = area
  const resX = Math.max(2, Math.min(DEPTH_MAX_RES, Math.ceil(w / DEPTH_TEXEL)))
  const resZ = Math.max(2, Math.min(DEPTH_MAX_RES, Math.ceil(h / DEPTH_TEXEL)))
  const depths = new Float32Array(resX * resZ)
  const beds = waterBedTargets()
  for (let j = 0; j < resZ; j++) {
    for (let i = 0; i < resX; i++) {
      const x = x0 + ((i + 0.5) / resX) * w
      const z = z0 + ((j + 0.5) / resZ) * h
      const g = waterBedHeight(beds, x, z, level + 0.01, MAX_DEPTH)
      let depth = g === null ? MAX_DEPTH : Math.max(0, level - g)
      if (g === null && waterBedHeight(beds, x, z, level + SHORE_PROBE, SHORE_PROBE) !== null) depth = 0
      depths[j * resX + i] = depth
    }
  }
  boxBlur(depths, resX, resZ, DEPTH_BLUR)
  boxBlur(depths, resX, resZ, DEPTH_BLUR)
  const data = new Uint16Array(resX * resZ)
  for (let k = 0; k < data.length; k++) data[k] = DataUtils.toHalfFloat(depths[k] / MAX_DEPTH)
  const texture = new DataTexture(data, resX, resZ, RedFormat, HalfFloatType)
  texture.magFilter = LinearFilter
  texture.minFilter = LinearFilter
  texture.needsUpdate = true
  return { texture, bounds: area }
}
