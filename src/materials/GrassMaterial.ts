import { Color, MeshStandardMaterial, Vector2, Vector4, type Texture } from 'three'
import { createCSM, type EdenCSM } from './csm'
import { shared } from './uniforms'
import noise from './chunks/noise.glsl?raw'
import wind from './chunks/wind.glsl?raw'
import fakeSSS from './chunks/fakeSSS.glsl?raw'

// 程序化草（garden）：一个 draw call，跟随相机的草叶网格。
// 每个实例 = 网格里的一格；格子坐标按「世界格」对齐，所以相机移动时叶子钉在世界里不滑动。
// 位置 / 高度 / 朝向 / 颜色全部由格子坐标的哈希在 vertex shader 里算出，CPU 每帧只推相机位置。
// 密度来自离线烘的密度图（模型局部坐标），高度来自加载时从碰撞体烘的高度图。

export function createGrassUniforms() {
  return {
    uCenter: { value: new Vector2() },
    uCell: { value: 0.2 },
    uSide: { value: 100 },
    uRadius: { value: 20 },
    uFadeStart: { value: 0.65 },
    uMask: { value: null as Texture | null },
    uHeightMap: { value: null as Texture | null },
    /** 密度图 / 高度图覆盖的模型局部范围：xy = 最小 x/z，zw = 边长 */
    uMaskBounds: { value: new Vector4(0, 0, 1, 1) },
    /** env 变换：xy = position.xz，z = scale，w = rotationY */
    uEnv: { value: new Vector4(0, 0, 1, 0) },
    uThreshold: { value: 0.15 },
    uBladeHeight: { value: new Vector2(0.3, 0.6) },
    uBladeWidth: { value: 0.05 },
    uBend: { value: 0.3 },
    uBaseColor: { value: new Color() },
    uTipColor: { value: new Color() },
    uColorVar: { value: 0.2 },
    uNormalUp: { value: 0.7 },
    uWindInfluence: { value: 0.6 },
    uGrassSSS: { value: 0.6 },
  }
}
export type GrassUniforms = ReturnType<typeof createGrassUniforms>

const vertexShader = /* glsl */ `
  ${noise}
  ${wind}
  uniform vec2 uCenter;
  uniform float uCell;
  uniform float uSide;
  uniform float uRadius;
  uniform float uFadeStart;
  uniform sampler2D uMask;
  uniform sampler2D uHeightMap;
  uniform vec4 uMaskBounds;
  uniform vec4 uEnv;
  uniform float uThreshold;
  uniform vec2 uBladeHeight;
  uniform float uBladeWidth;
  uniform float uBend;
  uniform float uNormalUp;
  uniform float uWindInfluence;

  attribute vec2 aCell;
  varying float vGrassT;
  varying float vGrassVar;
  varying vec3 vGrassWorld;
  varying vec3 vGrassNormal;

  float h1(vec2 c, float k) { return edenHash21(c + k * 17.31); }

  void main() {
    vec2 cellIdx = floor(uCenter / uCell) + aCell - floor(uSide * 0.5);
    vec2 xz = (cellIdx + vec2(h1(cellIdx, 1.0), h1(cellIdx, 2.0))) * uCell;

    // 世界 → 模型局部（与离线密度图同一坐标系）
    vec2 local = (xz - uEnv.xy) / uEnv.z;
    float cr = cos(-uEnv.w);
    float sr = sin(-uEnv.w);
    local = vec2(cr * local.x + sr * local.y, -sr * local.x + cr * local.y);
    vec2 uv = (local - uMaskBounds.xy) / uMaskBounds.zw;

    float keep = 0.0;
    vec4 hm = vec4(0.0);
    if (all(greaterThanEqual(uv, vec2(0.0))) && all(lessThanEqual(uv, vec2(1.0)))) {
      float density = texture2D(uMask, uv).r;
      // 密度越高，保留的概率越大
      keep = step(uThreshold, density) * step(h1(cellIdx, 3.0), smoothstep(uThreshold, 1.0, density) * 1.4);
      hm = texture2D(uHeightMap, uv);
      keep *= step(0.5, hm.g);
    }
    float dist = length(xz - uCenter);
    float fade = 1.0 - smoothstep(uRadius * uFadeStart, uRadius, dist);
    float s = keep * fade;

    float height = mix(uBladeHeight.x, uBladeHeight.y, h1(cellIdx, 4.0)) * s;
    float width = uBladeWidth * (0.7 + 0.6 * h1(cellIdx, 5.0)) * s;
    float yaw = h1(cellIdx, 6.0) * 6.2831853;
    float t = position.y;
    vec3 p = vec3(position.x * width * (1.0 - t * 0.85), t * height, uBend * t * t * height);
    float cy = cos(yaw);
    float sy = sin(yaw);
    p = vec3(cy * p.x + sy * p.z, p.y, -sy * p.x + cy * p.z);
    vec3 world = vec3(xz.x, hm.r, xz.y) + p;
    world += edenWindOffset(world, t) * uWindInfluence;

    csm_Position = world;
    vec3 n = vec3(sy, 0.0, cy);
    csm_Normal = normalize(mix(n, vec3(0.0, 1.0, 0.0), uNormalUp));
    vGrassT = t;
    vGrassVar = h1(cellIdx, 7.0);
    vGrassWorld = world;
    vGrassNormal = csm_Normal;
  }
`

const fragmentShader = /* glsl */ `
  ${fakeSSS}
  uniform vec3 uBaseColor;
  uniform vec3 uTipColor;
  uniform float uColorVar;
  uniform float uGrassSSS;
  varying float vGrassT;
  varying float vGrassVar;
  varying vec3 vGrassWorld;
  varying vec3 vGrassNormal;

  void main() {
    vec3 c = mix(uBaseColor, uTipColor, smoothstep(0.0, 1.0, vGrassT));
    c *= 1.0 + (vGrassVar - 0.5) * uColorVar;
    csm_DiffuseColor = vec4(c, 1.0);
    csm_Emissive += edenSSS(vGrassWorld, normalize(vGrassNormal), vGrassT) * uGrassSSS;
  }
`

export function createGrassMaterial(uniforms: GrassUniforms): EdenCSM {
  const m = createCSM('standard', new MeshStandardMaterial({ name: 'eden-grass', roughness: 0.9, side: 2 }), {
    vertexShader,
    fragmentShader,
    uniforms: { ...shared, ...uniforms },
    cacheKey: 'eden-grass-v1',
  })
  m.__edenRole = 'grass'
  return m
}
