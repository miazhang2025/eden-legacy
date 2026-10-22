import {
  Color,
  DoubleSide,
  HalfFloatType,
  LinearFilter,
  Matrix4,
  Mesh,
  MeshPhysicalMaterial,
  OrthographicCamera,
  PlaneGeometry,
  Scene,
  ShaderMaterial,
  Texture,
  Vector2,
  Vector4,
  WebGLRenderTarget,
  type WebGLRenderer,
} from 'three'
import { createCSM, type EdenCSM } from './csm'
import { shared } from './uniforms'
import noise from './chunks/noise.glsl?raw'

// 水面（spec §5.2C）。按档位：
//   low  ：程序化法线扰动 + 菲涅尔 + envMap 反射（physical 自带）
//   mid  ：+ 平面实时反射（Reflector，降分辨率，只渲染地形图层）+ 按水深的颜色渐变
//   high ：+ 屏幕空间折射（physical transmission）+ 岸边泡沫
// 水深来自一次性烘好的高度图（GPU 从正上方把水底画一遍），不需要每帧渲染深度图。

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
    /** 远处淡出：x = 开始距离，y = 完全透明距离（米，离 uFadeCenter 的水平距离）；y <= x 时关闭 */
    uDistanceFade: { value: new Vector2(0, 0) },
    uFadeCenter: { value: new Vector2(0, 0) },
    uOpacity: { value: 0.85 },
    uDepthMap: { value: null as Texture | null },
    /** 模糊过的水深图（只给深浅颜色用）：水下浅滩网格的边缘不会把多边形轮廓印在水面颜色上 */
    uDepthSmooth: { value: null as Texture | null },
    /** 高度图覆盖范围：xy = 最小 x/z，zw = 边长 */
    uDepthBounds: { value: new Vector4(0, 0, 1, 1) },
    uMaxDepth: { value: MAX_DEPTH },
    /** 1 = 水深来自网格顶点属性 _depth（生成的池塘水面），0 = 来自高度图 */
    uUseVertexDepth: { value: 0 },
    uDepthBlur: { value: 0.25 },
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
  uniform vec2 uDistanceFade;
  uniform vec2 uFadeCenter;
  uniform float uOpacity;
  uniform sampler2D uDepthMap;
  uniform sampler2D uDepthSmooth;
  uniform vec4 uDepthBounds;
  uniform float uMaxDepth;
  uniform float uUseVertexDepth;
  uniform float uDepthBlur;
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
    // 岸边用的水深：截断到 1 米再模糊（深水 / 虚空按 1 米算），岸线在模糊半径内平滑过渡
    float shoreDepth = 1.0;
    // 离岸远近（0 = 远离露出水面的地形）；网格水面 / 水深图之外沿用旧行为
    float landNear = 1.0;
    if (uUseVertexDepth > 0.5) {
      depth = vEdenDepth;
      shoreDepth = min(depth, 1.0);
    } else if (all(greaterThanEqual(duv, vec2(0.0))) && all(lessThanEqual(duv, vec2(1.0)))) {
      // 颜色用模糊过的水深（浅滩网格边缘外水深突变，单点采样会把网格的折线轮廓印成一圈马赛克）
      vec2 smoothDepth = texture2D(uDepthSmooth, duv).rg;
      depth = smoothDepth.r * uMaxDepth;
      // G 是露出水面地形的覆盖率（模糊半径 COLOR_BLUR）：岸线处约 0.5，离岸 1 米左右降到 0.25；只留紧贴岸线的一窄条
      landNear = smoothstep(0.25, 0.45, smoothDepth.g);
      // 5×5 取样（半径 uDepthBlur 米）：岸线由三角面围成，模糊后才是连续的过渡
      vec2 r = uDepthBlur / uDepthBounds.zw * 0.5;
      float sum = 0.0;
      for (int i = -2; i <= 2; i++)
        for (int j = -2; j <= 2; j++) sum += min(texture2D(uDepthMap, duv + vec2(float(i), float(j)) * r).r * uMaxDepth, 1.0);
      shoreDepth = sum / 25.0;
    }
    float t = uUseDepthColor > 0.5 ? smoothstep(0.0, uDepthFalloff, depth) : 1.0;
    vec3 col = mix(uShallowColor, uDeepColor, t);

    // 水下浅滩：完全淹没的平板状浅滩网格（投影生成，边缘是一段段台阶）按水深算也是「浅水」，
    // 岸边渐隐 / 泡沫 / 半透明会把它的折线轮廓透出来（一圈马赛克）。这些效果只在露出水面的地形附近（landNear）生效，
    // 远离岸的水下浅滩按普通水面处理；附近是深水（dropOff）时同样不透明、不起泡沫
    float dropOff = uUseVertexDepth > 0.5 ? 0.0 : smoothstep(0.6, 1.5, depth);
    float openWater = max(dropOff, 1.0 - landNear);
    float foam = 0.0;
    if (uUseFoam > 0.5) {
      foam = (1.0 - smoothstep(0.0, uFoamWidth, shoreDepth)) * (0.55 + 0.45 * edenNoise(vEdenWaterWorld.xz * 3.0 + flow * 4.0));
      foam *= 1.0 - openWater;
      col = mix(col, uFoamColor, foam);
    }
    // 岸边渐隐：越浅越透明，岸线由水深决定（模糊过的水深图是连续的），不再是地形多边形与水平面硬切出的锯齿
    // 各档位都开（只多一次水深采样）；没有水深数据时 uShoreFade = 0
    float shore = uShoreFade > 0.0 ? max(smoothstep(0.0, uShoreFade, shoreDepth), openWater) : 1.0;
    // 远处淡出：离水面中心越远越透明，开阔水面在地平线前消失，露出后面已混好雾色的天空，水天交界不再是一条硬线
    // 以水面中心而不是相机为基准：近处的水池始终完整，走动时淡出边界也不会跟着移动
    // 只淡出下面没有地形的开阔水面（平滑水深接近截断值 / 水深图之外）：有水底的地方一变透明就会透出水下网格的硬边
    if (uDistanceFade.y > uDistanceFade.x) {
      float open = uUseVertexDepth > 0.5 ? 1.0 : smoothstep(5.0, 7.5, depth);
      shore *= 1.0 - smoothstep(uDistanceFade.x, uDistanceFade.y, distance(vEdenWaterWorld.xz, uFadeCenter)) * open;
    }
    // 半透明（uOpacity）也只留在岸边：开阔水面透出去只会看到水下网格的硬边
    csm_DiffuseColor = vec4(col, mix(uOpacity, 1.0, max(foam, openWater)) * shore);

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
    cacheKey: 'eden-water-v4',
  })
  m.__edenRole = 'water'
  return m
}

/** 水深图每个像素覆盖多少米、单边最多多少像素（GPU 一次画完，可以给得很细） */
const DEPTH_TEXEL = 0.05
const DEPTH_MAX_RES = 1024
/** 水面上方多高以内的地形算「岸」（深度 0）；再往上的（洞顶、悬垂的岩石）不算 */
const SHORE_PROBE = 1.2
/** 水面着色器读水深时的模糊半径（米）：岸线由离散的三角面围成，模糊一下深浅过渡才连续 */
export const DEPTH_BLUR = 0.5

export interface DepthMap {
  texture: Texture
  /** 模糊过的水深（1/4 分辨率；R = 截到 COLOR_CLAMP 的水深，G = 离岸远近），给深浅颜色和岸边效果用 */
  smooth: Texture
  /** 覆盖的世界范围 x0, z0, 宽, 深（给 uDepthBounds） */
  bounds: [number, number, number, number]
  dispose(): void
}

// 烘焙用的材质：自定义投影，x / z 直接映射到贴图 u / v，深度按「离探测高度多远」排序（最高的表面胜出），
// 输出 R = 水深 / MAX_DEPTH（高出水面 → 0）
const bakeMaterial = new ShaderMaterial({
  side: DoubleSide,
  uniforms: {
    uArea: { value: new Vector4() },
    uLevel: { value: 0 },
    uTop: { value: 0 },
    uRange: { value: 1 },
    uMaxDepth: { value: MAX_DEPTH },
  },
  vertexShader: /* glsl */ `
    uniform vec4 uArea;
    uniform float uTop;
    uniform float uRange;
    varying float vY;
    void main() {
      vec4 wp = modelMatrix * vec4(position, 1.0);
      vY = wp.y;
      vec2 ndc = (wp.xz - uArea.xy) / uArea.zw * 2.0 - 1.0;
      // 高于 uTop 的被近裁剪面裁掉，越高越靠前
      gl_Position = vec4(ndc, (uTop - wp.y) / uRange * 2.0 - 1.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform float uLevel;
    uniform float uMaxDepth;
    varying float vY;
    void main() {
      // R = 水深；G = 露出水面的地形（岸），模糊后表示「离岸多近」
      gl_FragColor = vec4(clamp((uLevel - vY) / uMaxDepth, 0.0, 1.0), step(uLevel, vY), 0.0, 1.0);
    }
  `,
})
const bakeCamera = new OrthographicCamera()
const clearColor = new Color()

/** 颜色用水深的模糊半径（米）：要比浅滩网格边缘的台阶（投影生成的网格，约 0.5–1 米一段）大得多，轮廓才会变成柔和的一团 */
const COLOR_BLUR = 4
/** 模糊前把水深截到这个值（米）：没有地形的地方记为 MAX_DEPTH，不截的话过渡会被深的一侧吞掉；须大于各场景的 depthFalloff */
const COLOR_CLAMP = 8
/** 模糊图相对水深图的缩小倍数（颜色渐变不需要细节） */
const SMOOTH_DOWNSCALE = 4

// 9 抽头可分离高斯（横 / 竖各一遍），R 采样前截深，G（岸）照常模糊
const blurMaterial = new ShaderMaterial({
  depthTest: false,
  depthWrite: false,
  uniforms: {
    uSrc: { value: null as Texture | null },
    uDir: { value: new Vector2() },
    uClamp: { value: COLOR_CLAMP / MAX_DEPTH },
  },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() {
      vUv = uv;
      gl_Position = vec4(position.xy, 0.0, 1.0);
    }
  `,
  fragmentShader: /* glsl */ `
    uniform sampler2D uSrc;
    uniform vec2 uDir;
    uniform float uClamp;
    varying vec2 vUv;
    vec2 tap(vec2 uv) {
      vec2 v = texture2D(uSrc, uv).rg;
      return vec2(min(v.x, uClamp), v.y);
    }
    void main() {
      vec2 s = tap(vUv) * 0.227027;
      s += (tap(vUv + uDir) + tap(vUv - uDir)) * 0.1945946;
      s += (tap(vUv + uDir * 2.0) + tap(vUv - uDir * 2.0)) * 0.1216216;
      s += (tap(vUv + uDir * 3.0) + tap(vUv - uDir * 3.0)) * 0.054054;
      s += (tap(vUv + uDir * 4.0) + tap(vUv - uDir * 4.0)) * 0.016216;
      gl_FragColor = vec4(s, 0.0, 1.0);
    }
  `,
})
const blurScene = new Scene()
const blurQuad = new Mesh(new PlaneGeometry(2, 2), blurMaterial)
blurQuad.frustumCulled = false
blurScene.add(blurQuad)

/**
 * 烘水深图（GPU，一次绘制，几毫秒）：把水底网格（collision.ts 的 waterBedMeshes：渲染模型的地形 mesh，没有时用碰撞体）
 * 从正上方画进一张半精度浮点贴图，R = 水深 / MAX_DEPTH。
 * - 只看水面以上 SHORE_PROBE 米以内：高出水面的岸 → 深度 0；洞顶等更高的东西被裁掉
 * - 水面以下没有地形（如 ocean 的浮岛之间）= 清屏色 = 最大深度
 * 只烘 area（水面与场景边界的交集）：水面往往比能走到的范围大得多，烘整片会把分辨率浪费在看不到的地方。
 * （以前在 CPU 上逐像素打射线，一张图要好几秒，切场景时卡住黑屏）
 */
export function bakeDepthMap(
  gl: WebGLRenderer,
  meshes: Mesh[],
  level: number,
  area: [number, number, number, number],
): DepthMap {
  const [x0, z0, w, h] = area
  const resX = Math.max(2, Math.min(DEPTH_MAX_RES, Math.ceil(w / DEPTH_TEXEL)))
  const resZ = Math.max(2, Math.min(DEPTH_MAX_RES, Math.ceil(h / DEPTH_TEXEL)))
  const target = new WebGLRenderTarget(resX, resZ, {
    type: HalfFloatType,
    minFilter: LinearFilter,
    magFilter: LinearFilter,
    depthBuffer: true,
  })
  const u = bakeMaterial.uniforms
  u.uArea.value.set(x0, z0, w, h)
  u.uLevel.value = level
  u.uTop.value = level + SHORE_PROBE
  u.uRange.value = SHORE_PROBE + MAX_DEPTH

  // 临时场景：共用原网格的几何体，套原网格的世界矩阵
  const scene = new Scene()
  for (const m of meshes) {
    m.updateWorldMatrix(true, false)
    const proxy = new Mesh(m.geometry, bakeMaterial)
    proxy.matrixAutoUpdate = false
    proxy.matrix.copy(m.matrixWorld)
    // matrixAutoUpdate 关掉时 three 只在这个标记为 true 时才用 matrix 算 matrixWorld
    proxy.matrixWorldNeedsUpdate = true
    proxy.frustumCulled = false
    scene.add(proxy)
  }

  const prevTarget = gl.getRenderTarget()
  const prevAlpha = gl.getClearAlpha()
  gl.getClearColor(clearColor)
  const prevAutoClear = gl.autoClear
  gl.setRenderTarget(target)
  gl.setClearColor(0xff0000, 1)
  gl.autoClear = true
  gl.render(scene, bakeCamera)

  // 颜色用的平滑水深：缩小后横竖各模糊两遍（ping-pong），一共 4 次全屏绘制
  const sw = Math.max(2, Math.ceil(resX / SMOOTH_DOWNSCALE))
  const sh = Math.max(2, Math.ceil(resZ / SMOOTH_DOWNSCALE))
  const opts = { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false }
  const ping = new WebGLRenderTarget(sw, sh, opts)
  const pong = new WebGLRenderTarget(sw, sh, opts)
  // 每个抽头的间距：4 个抽头覆盖 COLOR_BLUR 米
  const stepX = COLOR_BLUR / 4 / w
  const stepZ = COLOR_BLUR / 4 / h
  const b = blurMaterial.uniforms
  const pass = (src: Texture, dst: WebGLRenderTarget, dx: number, dz: number) => {
    b.uSrc.value = src
    b.uDir.value.set(dx, dz)
    gl.setRenderTarget(dst)
    gl.render(blurScene, bakeCamera)
  }
  pass(target.texture, ping, stepX, 0)
  pass(ping.texture, pong, 0, stepZ)
  pass(pong.texture, ping, stepX, 0)
  pass(ping.texture, pong, 0, stepZ)
  b.uSrc.value = null
  ping.dispose()

  gl.setRenderTarget(prevTarget)
  gl.setClearColor(clearColor, prevAlpha)
  gl.autoClear = prevAutoClear

  return {
    texture: target.texture,
    smooth: pong.texture,
    bounds: area,
    dispose: () => {
      target.dispose()
      pong.dispose()
    },
  }
}
