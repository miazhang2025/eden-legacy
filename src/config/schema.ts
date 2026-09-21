// Config 的 TS 类型 + look dev 面板元信息（spec §9.2）。
// 面板完全由下面的 SCENE_SCHEMA / ENDING_SCHEMA 自动生成：新增参数只需改类型 + schema + json，不用动面板代码。
// SchemaFor<T> 保证 config 的每个字段在 schema 里都有对应项，漏写会编译报错。

export type SceneId = 'cave' | 'ocean' | 'garden'
export type ConfigId = SceneId | 'ending'
/** store 里的全部 config：四个页面 + 全局 */
export type StoreId = ConfigId | 'global'
export type QualityTier = 'low' | 'mid' | 'high'

export type Vec2 = [number, number]
export type Vec3 = [number, number, number]
export type Vec4 = [number, number, number, number]

export interface SceneConfig {
  version: 1
  scene: SceneId
  camera: {
    fov: number
    near: number
    far: number
    followDistance: number
    followHeight: number
    lookAtOffset: number
    damping: number
    rotateSpeed: number
    pitchMin: number
    pitchMax: number
    /** 相机离地最小高度，防止钻进地形 */
    minGroundClearance: number
    /** 被地形遮挡时，相机停在遮挡点之前的距离 */
    occlusionPadding: number
    /** 遮挡拉近时相机离角色的最小距离 */
    minDistance: number
    /** 进入场景时的俯仰角（弧度） */
    initialPitch: number
  }
  /** 环境模型。model 为空时显示色块占位地面 */
  env: {
    model: string
    collider: string
    scale: number
    position: Vec3
    rotationY: number
  }
  character: {
    moveSpeed: number
    sprintMultiplier: number
    turnSpeed: number
    radius: number
    height: number
    color: string
    /** 只用 x/z，y 由地面射线决定 */
    spawn: Vec3
    spawnYaw: number
    /** 能直接迈上去的最大高度差 */
    stepHeight: number
    /** 能直接走下去的最大落差，超过视为悬崖边，阻挡 */
    maxDrop: number
    /** 贴地平滑时间常数（秒） */
    groundSmoothing: number
  }
  render: {
    exposure: number
    pixelRatioMax: number
  }
  background: string
  fog: {
    type: 'none' | 'linear' | 'exp2'
    color: string
    density: number
    near: number
    far: number
  }
  lights: {
    ambient: { color: string; intensity: number }
    directional: { color: string; intensity: number; position: Vec3 }
    /** 每场景 2–4 盏点光，可增删 */
    points: PointLightConfig[]
  }
  bounds: { min: Vec3; max: Vec3 }
  /** 程序化天空盒（HDRI 到位前使用；程序化环境光也用它渲染） */
  sky: SkyConfig
  environment: EnvironmentConfig
  shadows: ShadowConfig
  wind: WindConfig
  sss: SSSConfig
  crystal: CrystalConfig
  water: WaterConfig
  /** 贴图池塘：地形贴图里画出来的水域，用 shader 按颜色遮罩做成水面（garden） */
  pond: PondConfig
  /** 程序化草：跟随相机的草叶网格，一个 draw call */
  grass: GrassConfig
  /** 引导发光粒子的远近强度（spec §5.1） */
  beacon: BeaconConfig
  /** 粒子池（spec §5.3）：每个池一个 draw call，多个发射点共享 */
  particles: ParticlePool[]
  post: PostConfig
  /** 按 material name 覆盖模型材质；只存与模型原值不同的字段，未出现的材质保持模型自带值 */
  materials: Record<string, MaterialOverride>
  audio: AudioConfig
  mobile: {
    pixelRatioMax: number
    joystickRadius: number
    joystickSensitivity: number
    lookSensitivity: number
  }
  /** M0/M1 色块占位地面，接入环境模型后移除 */
  placeholder: {
    groundColor: string
    groundSize: number
    zoneColor: string
    zoneOpacity: number
    assetRoughness: number
    assetMetalness: number
  }
  flow: {
    zoneCenter: Vec3
    zoneRadius: number
    proximity: number
    othersFadeOut: boolean
    /** 被选资产发光增强时长（秒） */
    selectGlowDuration: number
    /** 淡出时长（秒） */
    fadeDuration: number
    /** 淡出完成后到跳转前的停顿（秒） */
    resolveDelay: number
    idleEmissive: number
    activeEmissive: number
    inspectEmissive: number
    selectedEmissive: number
    breatheSpeed: number
    /** 呼吸幅度 0–1：发光在 (1-depth)~1 倍之间起伏 */
    breatheDepth: number
    /** 发光强度变化的平滑时间常数（秒） */
    emissiveDamping: number
    /** 激活后资产自转速度（弧度/秒） */
    spinSpeed: number
    /** 资产离地高度（占位几何体中心），接入真实模型后按模型原点调整 */
    assetLift: number
    floatAmplitude: number
    floatSpeed: number
    /** 点击判定：拖拽超过该像素数不算点击 */
    clickDragThreshold: number
  }
}

export type MaterialSide = 'front' | 'back' | 'double'
/** 材质角色：决定用哪套自定义 shader。默认按材质名前缀（veg_ / crystal_ / water_ / emitter_），面板可改 */
export type MaterialRole = 'static' | 'vegetation' | 'crystal' | 'water' | 'emitter'

export interface MaterialOverride {
  role?: MaterialRole
  color?: string
  roughness?: number
  metalness?: number
  emissive?: string
  emissiveIntensity?: number
  envMapIntensity?: number
  normalScale?: number
  opacity?: number
  transparent?: boolean
  alphaTest?: number
  side?: MaterialSide
  wireframe?: boolean
  // 以下仅 MeshPhysicalMaterial
  clearcoat?: number
  transmission?: number
  ior?: number
  thickness?: number
  attenuationColor?: string
}

export interface SkyConfig {
  /** 关闭时背景用纯色 background */
  enabled: boolean
  topColor: string
  midColor: string
  horizonColor: string
  bottomColor: string
  /** 中段颜色所在高度（0 = 地平线，1 = 天顶） */
  midHeight: number
  /** 地平线雾带宽度 */
  horizonWidth: number
  /** 太阳（方向取主光 position） */
  sunColor: string
  /** 太阳圆盘角半径（弧度），0 = 不画圆盘 */
  sunSize: number
  sunIntensity: number
  /** 太阳周围光晕的强度与扩散 */
  sunGlow: number
  sunGlowSpread: number
  moon: {
    enabled: boolean
    color: string
    /** 方位角 / 仰角（度） */
    azimuth: number
    elevation: number
    /** 角半径（弧度） */
    size: number
    /** 边缘柔和度 0–1 */
    softness: number
    intensity: number
  }
}

export interface EnvironmentConfig {
  /** procedural = 用天空盒渲染环境光（无需下载），hdri = 读 public/hdri 下的文件 */
  mode: 'procedural' | 'hdri'
  hdri: string
  intensity: number
  rotationY: number
  /** hdri 模式下是否同时作为背景（否则背景仍是程序化天空） */
  background: boolean
  /** 环境光里对应主光方向的亮斑强度 */
  sunIntensity: number
}

export interface ShadowConfig {
  enabled: boolean
  bias: number
  normalBias: number
  /** 软阴影半径（soft 档位） */
  radius: number
  /** 主光阴影相机覆盖范围（半边长） */
  cameraSize: number
  cameraFar: number
}

export interface WindConfig {
  enabled: boolean
  directionDeg: number
  strength: number
  speed: number
  /** 噪声空间频率 */
  scale: number
  gustStrength: number
  gustFrequency: number
  gustScale: number
  flutterStrength: number
  flutterFrequency: number
  headSway: number
  /** 柔软度来源：顶点色 R，或按局部高度归一化 */
  stiffnessSource: 'vertexColor' | 'localY'
  /** 柔软度曲线指数：越大根部越稳 */
  stiffnessPower: number
  /** 采集确认时的一阵风 */
  confirmGustStrength: number
  confirmGustDuration: number
}

export interface SSSConfig {
  enabled: boolean
  color: string
  scale: number
  power: number
  distortion: number
  ambient: number
  thickness: number
  thicknessSource: 'constant' | 'vertexColor'
  /** 额外参与计算的点光名（空 = 只算主光；仅 full 档生效） */
  pointLight: string
}

export interface CrystalConfig {
  /** 关闭时所有晶体退化为不透明 */
  enabled: boolean
  transmission: number
  thickness: number
  ior: number
  roughness: number
  attenuationColor: string
  attenuationDistance: number
  glowColor: string
  glowIntensity: number
  fresnelPower: number
  /** 包围盒最长边 ≥ 该值算「主体」晶体（mid 档只有主体用 transmission） */
  mainMinSize: number
  /** 不透明降级时的 envMapIntensity（伪装成透明感） */
  opaqueEnvMapIntensity: number
}

export interface WaterConfig {
  enabled: boolean
  quality: QualityTier
  /** 水面高度 */
  level: number
  /** 水面平面中心（x/z）与边长 */
  center: Vec3
  size: number
  shallowColor: string
  deepColor: string
  /** 深度到达该值时完全变为 deepColor */
  depthFalloff: number
  normalScale: number
  normalStrength: number
  flowSpeed: number
  flowDirectionDeg: number
  fresnelPower: number
  roughness: number
  reflectionIntensity: number
  /** 实时反射贴图分辨率（边长像素），最大的性能旋钮；移动端自动减半 */
  reflectionResolution: number
  reflectionLayers: 'terrain' | 'terrain+vegetation'
  refractionStrength: number
  foamWidth: number
  foamColor: string
  causticsIntensity: number
  causticsScale: number
  causticsSpeed: number
  opacity: number
  /** 水深超过该值的区域不可行走（0 = 不限制） */
  blockDepth: number
  /** 水面可以行走（ocean：在浮岛之间「走水」） */
  walkable: boolean
}

export interface PondConfig {
  enabled: boolean
  /** 画有池塘的地形材质名 */
  material: string
  /** 池塘在贴图里的颜色，与之距离在 tolerance 内的像素视为水 */
  maskColor: string
  tolerance: number
  softness: number
  /** 水色与偏色强度 */
  color: string
  tint: number
  roughness: number
  normalScale: number
  normalStrength: number
  flowSpeed: number
  flowDirectionDeg: number
  fresnelPower: number
  /** 掠射角叠加天空（地平线色）的强度 */
  reflection: number
}

export interface GrassConfig {
  enabled: boolean
  /** 离线烘好的密度图（npm run models 生成，旁边有同名 .json 记录范围） */
  mask: string
  /** high 档的草叶数量（其它档位按档位表的 grass 倍率缩减） */
  count: number
  /** 以相机为中心的草地半径（世界单位） */
  radius: number
  /** 从 radius × fadeStart 开始逐渐缩小消失 */
  fadeStart: number
  /** 密度图低于该值的地方不长草 */
  densityThreshold: number
  bladeHeight: Vec2
  bladeWidth: number
  /** 叶尖弯曲程度（静态） */
  bend: number
  baseColor: string
  tipColor: string
  /** 每片叶子的明度随机幅度 */
  colorVariation: number
  /** 法线向上方混合的比例：越大越柔和（避免叶片正反面明暗跳变） */
  normalUp: number
  /** 风对草的影响倍率（共用风动参数） */
  windInfluence: number
  /** 背光透光（共用假 SSS 参数）的倍率 */
  sss: number
  receiveShadow: boolean
}

export interface BeaconConfig {
  /** 距离 ≥ far 时用 farIntensity，≤ near 时用 nearIntensity，中间插值 */
  falloffNear: number
  falloffFar: number
  zoneFarIntensity: number
  zoneNearIntensity: number
  /** 进入采集区后采集区光团降到的强度 */
  zoneInsideIntensity: number
  assetFarIntensity: number
  assetNearIntensity: number
}

export type ParticleRole = 'ambient' | 'beaconZone' | 'beaconAsset' | 'burst' | 'modelEmitters'

export interface ParticleEmitter {
  name: string
  position: Vec3
  emitCount: number
  delay: number
}

/** 字段名对齐 r3f-vfx 的 props（spec §5.3G） */
export interface ParticlePool {
  name: string
  enabled: boolean
  /** 发射点来源：ambient 用 emitters（可跟随相机），beacon* / burst / modelEmitters 由场景自动生成 */
  role: ParticleRole
  maxParticles: number
  emitterShape: 'point' | 'box' | 'sphere' | 'cone' | 'disk'
  emitterRadius: number
  emitterSize: Vec3
  emitterAngle: number
  emitterHeight: number
  emitterDirection: Vec3
  emitterSurfaceOnly: boolean
  startPositionAsDirection: boolean
  lifetime: Vec2
  speed: Vec2
  /** 速度方向的随机扩散（弧度） */
  directionSpread: number
  gravity: Vec3
  friction: { intensity: number; easing: 'linear' | 'easeIn' | 'easeOut' }
  turbulence: { intensity: number; frequency: number; speed: number }
  size: Vec2
  colorStart: string
  colorEnd: string
  intensity: number
  blending: 'additive' | 'normal'
  appearance: 'gradient' | 'circular' | 'square'
  /** 生命周期曲线：4 个贝塞尔控制点的 y 值（x 均匀分布），运行时烘成纹理 */
  fadeSizeCurve: Vec4
  fadeOpacityCurve: Vec4
  velocityCurve: Vec4
  rotation: Vec2
  rotationSpeed: Vec2
  /** 近相机淡出距离（降级 soft particles） */
  softDistance: number
  /** 贴近地面淡出的高度 */
  groundFade: number
  /** 发射区跟随相机（环境浮尘类），发射点位置视为相对相机 */
  followCamera: boolean
  depthTest: boolean
  renderOrder: number
  emitters: ParticleEmitter[]
}

export interface PostConfig {
  enabled: boolean
  toneMapping: 'aces' | 'agx' | 'neutral' | 'reinhard' | 'linear'
  bloom: { enabled: boolean; intensity: number; threshold: number; smoothing: number; radius: number }
  vignette: { enabled: boolean; offset: number; darkness: number }
  chromaticAberration: { enabled: boolean; offset: number }
  dof: { enabled: boolean; focusDistance: number; focalLength: number; bokehScale: number }
  noise: { enabled: boolean; opacity: number }
  grade: { enabled: boolean; hue: number; saturation: number; contrast: number; brightness: number }
  /** 性能开销大，默认关闭；移动端强制关闭 */
  ssao: { enabled: boolean; intensity: number; radius: number }
}

/** 音频总线（素材未到位，当前为静音占位，参数先存在） */
export interface AudioConfig {
  master: { volume: number; mute: boolean }
  ambience: { volume: number; mute: boolean; fadeIn: number; fadeOut: number }
  sfx: { volume: number; mute: boolean; collectVolume: number }
}

export interface PointLightConfig {
  name: string
  color: string
  intensity: number
  distance: number
  decay: number
  position: Vec3
}

export interface SlotConfig {
  position: Vec3
  rotation: Vec3
  scale: number
  /** 开启时按资产包围盒最长边缩放到 fitSize */
  autoFit: boolean
  fitSize: number
}

export interface EndingConfig {
  version: 1
  scene: 'ending'
  camera: { fov: number; position: Vec3; lookAt: Vec3 }
  background: string
  lights: {
    ambient: { color: string; intensity: number }
    directional: { color: string; intensity: number; position: Vec3 }
  }
  frame: {
    mode: '3d' | 'plane'
    color: string
    metalness: number
    roughness: number
    backColor: string
    backRoughness: number
    size: Vec3
    border: number
    planeDepth: number
  }
  slots: { slotA: SlotConfig; slotB: SlotConfig; slotC: SlotConfig }
  /** 标本（占位几何体）的材质 */
  specimen: { emissiveIntensity: number; roughness: number; metalness: number; hoverEmissive: number }
  /** 入场：画布淡入 + 标本盒放大 + 三件标本依次落位（自己写，不用 Theatre 时间轴，见 ADR-003） */
  reveal: {
    fadeDuration: number
    textDelay: number
    /** 标本盒从多大放到 1（1 = 不缩放） */
    boxScaleFrom: number
    boxDuration: number
    /** 每件标本的入场时长与相互错开的间隔 */
    specimenDuration: number
    specimenStagger: number
    /** 标本入场时的起始偏移（相对各自 slot） */
    specimenFrom: Vec3
  }
  /** 影棚环境光：上下两色的渐变球 + 一块柔光板，渲染一次作为环境贴图 */
  environment: {
    intensity: number
    rotationY: number
    topColor: string
    bottomColor: string
    /** 柔光板（放在主光方向）的强度与大小 */
    keyIntensity: number
    keySize: number
  }
  shadows: ShadowConfig
  post: PostConfig
  /** 标本盒的有限交互（spec §8.3）：不做自由 orbit，不允许转到背面 */
  interaction: {
    yawLimitDeg: number
    pitchLimitDeg: number
    /** 每拖动 1 像素转多少度 */
    dragSensitivity: number
    /** 旋转 / 缩放的平滑时间常数（秒） */
    damping: number
    /** 相机距离倍率范围（1 = config 里的相机位置） */
    zoomMin: number
    zoomMax: number
    zoomSpeed: number
    /** 松手多久后缓慢回正（秒），0 = 不回正 */
    returnDelay: number
    /** 静止时的轻微呼吸摆动（度） */
    idleSwayDeg: number
    idleSwaySpeed: number
  }
  /** 照片导出（spec §8.4） */
  photo: {
    /** 相对屏幕画布的渲染倍率 */
    scale: number
    /** 边距（以 1 倍率的像素计） */
    margin: number
    background: string
    borderWidth: number
    borderColor: string
    includeText: boolean
    titleSize: number
    descSize: number
    textColor: string
    descColor: string
    textGap: number
    includeLogo: boolean
    /** public 下的 logo 图片路径 */
    logo: string
    logoSize: number
  }
}

/** 每个质量档位的效果上限（spec §12.1） */
export interface TierSettings {
  pixelRatioMax: number
  water: QualityTier
  /** 风动层数：1 = 主风，2 = + 阵风，3 = + 抖动 */
  windLayers: number
  sss: 'off' | 'single' | 'full'
  /** transmission 晶体：none = 全部不透明，main = 仅主体，all = 主体 + 次级 */
  crystal: 'none' | 'main' | 'all'
  shadows: 'off' | 'on' | 'soft'
  shadowMapSize: number
  /** 粒子数量倍率 */
  particles: number
  /** 程序化草叶数量倍率 */
  grass: number
  /** basic = bloom + 调色，mid = + vignette + grain，full = 全开（含 DOF） */
  post: 'basic' | 'mid' | 'full'
}

export interface GlobalConfig {
  version: 1
  scene: 'global'
  transition: { fadeOut: number; fadeIn: number; color: string }
  quality: {
    desktopDefault: QualityTier
    mobileDefault: QualityTier
    tiers: { low: TierSettings; mid: TierSettings; high: TierSettings }
    /** spec §12.2 帧率守门：连续 window 秒低于目标的 threshold 倍 → 降一档（只降不升） */
    frameGuard: {
      enabled: boolean
      targetFpsDesktop: number
      targetFpsMobile: number
      threshold: number
      window: number
      /** 进入场景后多少秒开始监控（避开加载抖动） */
      warmup: number
    }
  }
}

export type AnyConfig = SceneConfig | EndingConfig

export type DeepPartial<T> = { [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K] }

// ============================================================================
// 面板元信息
// ============================================================================

interface LeafBase {
  label?: string
  /** 鼠标悬停提示 */
  hint?: string
}
export interface NumberLeaf extends LeafBase { t: 'number'; min?: number; max?: number; step?: number }
export interface BoolLeaf extends LeafBase { t: 'bool' }
export interface ColorLeaf extends LeafBase { t: 'color' }
export interface TextLeaf extends LeafBase { t: 'text' }
export interface SelectLeaf<V extends string = string> extends LeafBase { t: 'select'; options: readonly V[] }
export interface Vec3Leaf extends LeafBase { t: 'vec3'; min?: number; max?: number; step?: number }
export interface Vec2Leaf extends LeafBase { t: 'vec2'; min?: number; max?: number; step?: number }
export interface Vec4Leaf extends LeafBase { t: 'vec4'; min?: number; max?: number; step?: number }
/** 不在面板里显示（version / scene 等结构字段） */
export interface HiddenLeaf { t: 'hidden' }
/** 可增删的数组（如点光） */
export interface ArrayLeaf<U = unknown> extends LeafBase {
  t: 'array'
  item: SchemaFor<U>
  itemLabel: (item: U, index: number) => string
  create: (existing: U[]) => U
}
/** 材质：运行时遍历场景收集 material name 动态生成 */
export interface MaterialsLeaf { t: 'materials' }

export interface FolderMeta {
  _label?: string
}

export type Leaf =
  | NumberLeaf
  | BoolLeaf
  | ColorLeaf
  | TextLeaf
  | SelectLeaf
  | Vec3Leaf
  | Vec2Leaf
  | Vec4Leaf
  | HiddenLeaf
  | ArrayLeaf<any> // eslint-disable-line @typescript-eslint/no-explicit-any
  | MaterialsLeaf

export type SchemaFor<T> = [T] extends [number]
  ? NumberLeaf | HiddenLeaf
  : [T] extends [boolean]
    ? BoolLeaf | HiddenLeaf
    : [T] extends [string]
      ? string extends T
        ? ColorLeaf | TextLeaf | HiddenLeaf
        : SelectLeaf<T & string> | HiddenLeaf
      : [T] extends [Vec3]
        ? Vec3Leaf | HiddenLeaf
        : [T] extends [Vec2]
          ? Vec2Leaf | HiddenLeaf
          : [T] extends [Vec4]
            ? Vec4Leaf | HiddenLeaf
            : T extends readonly (infer U)[]
          ? ArrayLeaf<U>
          : string extends keyof T
            ? MaterialsLeaf
            : { [K in keyof T]-?: SchemaFor<T[K]> } & FolderMeta

export const isLeaf = (n: unknown): n is Leaf => typeof n === 'object' && n !== null && 't' in n

// ---------- 常用片段 ----------
const hidden: HiddenLeaf = { t: 'hidden' }
const color = (label?: string): ColorLeaf => ({ t: 'color', label })
const num = (min: number, max: number, step: number, label?: string, hint?: string): NumberLeaf => ({
  t: 'number',
  min,
  max,
  step,
  label,
  hint,
})
const vec = (step = 0.1, label?: string): Vec3Leaf => ({ t: 'vec3', step, label })
const range = (min: number, max: number, step: number, label?: string): Vec2Leaf => ({ t: 'vec2', min, max, step, label })
const curve = (label?: string): Vec4Leaf => ({ t: 'vec4', min: 0, max: 2, step: 0.01, label })
const select = <V extends string>(...options: V[]): SelectLeaf<V> => ({ t: 'select', options })
const bool = (label?: string, hint?: string): BoolLeaf => ({ t: 'bool', label, hint })
const intensity = (max = 10) => num(0, max, 0.01)
const seconds = (max = 5) => num(0, max, 0.05)

const lightsSchema = {
  _label: '灯光',
  ambient: { _label: 'ambient', color: color(), intensity: intensity(5) },
  directional: { _label: 'directional 主光', color: color(), intensity: intensity(10), position: vec(0.5) },
}

/** 材质面板里可调的字段（spec §9.3 Materials）；physical 为 true 的只对 MeshPhysicalMaterial 显示 */
export const MATERIAL_FIELDS: Array<{ key: keyof MaterialOverride; leaf: Leaf; physical?: boolean }> = [
  { key: 'role', leaf: { t: 'select', options: ['static', 'vegetation', 'crystal', 'water', 'emitter'], label: 'role 角色' } },
  { key: 'color', leaf: color() },
  { key: 'roughness', leaf: num(0, 1, 0.01) },
  { key: 'metalness', leaf: num(0, 1, 0.01) },
  { key: 'emissive', leaf: color() },
  { key: 'emissiveIntensity', leaf: intensity(20) },
  { key: 'envMapIntensity', leaf: intensity(5) },
  { key: 'normalScale', leaf: num(0, 3, 0.01) },
  { key: 'opacity', leaf: num(0, 1, 0.01) },
  { key: 'transparent', leaf: bool() },
  { key: 'alphaTest', leaf: num(0, 1, 0.01) },
  { key: 'side', leaf: { t: 'select', options: ['front', 'back', 'double'] } },
  { key: 'wireframe', leaf: bool('wireframe (debug)') },
  { key: 'clearcoat', leaf: num(0, 1, 0.01), physical: true },
  { key: 'transmission', leaf: num(0, 1, 0.01), physical: true },
  { key: 'ior', leaf: num(1, 2.333, 0.01), physical: true },
  { key: 'thickness', leaf: num(0, 10, 0.01), physical: true },
  { key: 'attenuationColor', leaf: color(), physical: true },
]

/** 新建粒子池的默认值 */
export const DEFAULT_PARTICLE_POOL: ParticlePool = {
  name: 'pool',
  enabled: true,
  role: 'ambient',
  maxParticles: 300,
  emitterShape: 'box',
  emitterRadius: 1,
  emitterSize: [20, 6, 20],
  emitterAngle: 0.4,
  emitterHeight: 0,
  emitterDirection: [0, 1, 0],
  emitterSurfaceOnly: false,
  startPositionAsDirection: false,
  lifetime: [4, 8],
  speed: [0.05, 0.2],
  directionSpread: 1.5,
  gravity: [0, 0, 0],
  friction: { intensity: 0, easing: 'linear' },
  turbulence: { intensity: 0.2, frequency: 0.4, speed: 0.3 },
  size: [0.03, 0.08],
  colorStart: '#ffffff',
  colorEnd: '#ffffff',
  intensity: 1,
  blending: 'additive',
  appearance: 'gradient',
  fadeSizeCurve: [1, 1, 1, 1],
  fadeOpacityCurve: [0, 1, 1, 0],
  velocityCurve: [1, 1, 1, 1],
  rotation: [0, 0],
  rotationSpeed: [0, 0],
  softDistance: 0.8,
  groundFade: 0.3,
  followCamera: false,
  depthTest: true,
  renderOrder: 0,
  emitters: [],
}

/** 后处理面板项（场景与 ending 共用） */
const postSchema: SchemaFor<PostConfig> = {
  _label: '后处理 post',
  enabled: bool(),
  toneMapping: select('aces', 'agx', 'neutral', 'reinhard', 'linear'),
  bloom: { _label: 'bloom', enabled: bool(), intensity: intensity(5), threshold: num(0, 2, 0.01), smoothing: num(0, 1, 0.01), radius: num(0, 1, 0.01) },
  vignette: { _label: 'vignette', enabled: bool(), offset: num(0, 1, 0.01), darkness: num(0, 1, 0.01) },
  chromaticAberration: { _label: 'chromaticAberration', enabled: bool(), offset: num(0, 0.02, 0.0001) },
  dof: { _label: 'depthOfField', enabled: bool(), focusDistance: num(0, 100, 0.1), focalLength: num(0.1, 20, 0.1), bokehScale: num(0, 10, 0.1) },
  noise: { _label: 'noise / grain', enabled: bool(), opacity: num(0, 0.5, 0.005) },
  grade: {
    _label: '调色 grade',
    enabled: bool(),
    hue: num(-Math.PI, Math.PI, 0.01),
    saturation: num(-1, 1, 0.01),
    contrast: num(-1, 1, 0.01),
    brightness: num(-1, 1, 0.01),
  },
  ssao: { _label: 'SSAO（开销大）', enabled: bool(), intensity: num(0, 10, 0.1), radius: num(0.01, 2, 0.01) },
}

export const SCENE_SCHEMA: SchemaFor<SceneConfig> = {
  version: hidden,
  scene: hidden,
  camera: {
    _label: '相机',
    fov: num(20, 90, 0.5),
    near: num(0.01, 5, 0.01),
    far: num(50, 2000, 10),
    followDistance: num(1, 30, 0.1),
    followHeight: num(0, 15, 0.1),
    lookAtOffset: num(0, 5, 0.05),
    damping: num(0, 1, 0.01, 'damping (s)', '跟随阻尼时间常数，0 = 硬跟随'),
    rotateSpeed: num(0.001, 0.02, 0.0005),
    pitchMin: num(-1.5, 1.5, 0.01),
    pitchMax: num(-1.5, 1.5, 0.01),
    minGroundClearance: num(0, 3, 0.05),
    occlusionPadding: num(0, 2, 0.05),
    minDistance: num(0.1, 5, 0.05),
    initialPitch: num(-1.5, 1.5, 0.01),
  },
  env: {
    _label: '环境模型',
    model: { t: 'text' },
    collider: { t: 'text' },
    scale: num(0.1, 50, 0.01, 'scale', '模型缩放。碰撞体同步，但资产/出生点/采集区坐标不会跟着缩放'),
    position: vec(0.1),
    rotationY: num(-Math.PI, Math.PI, 0.01),
  },
  character: {
    _label: '角色',
    moveSpeed: num(0.5, 15, 0.1),
    sprintMultiplier: num(1, 4, 0.05),
    turnSpeed: num(1, 30, 0.5),
    radius: num(0.1, 1.5, 0.01),
    height: num(0.5, 4, 0.05),
    color: color(),
    spawn: vec(0.5, 'spawn (x/z)'),
    spawnYaw: num(-Math.PI, Math.PI, 0.01),
    stepHeight: num(0, 2, 0.01),
    maxDrop: num(0, 5, 0.05),
    groundSmoothing: num(0, 0.5, 0.01, 'groundSmoothing (s)'),
  },
  render: {
    _label: '渲染',
    exposure: num(0, 4, 0.01),
    pixelRatioMax: num(0.5, 3, 0.25),
  },
  background: color('背景色'),
  fog: {
    _label: '雾',
    type: { t: 'select', options: ['none', 'linear', 'exp2'] },
    color: color(),
    density: num(0, 0.2, 0.001, 'density (exp2)'),
    near: num(0, 200, 0.5, 'near (linear)'),
    far: num(1, 500, 1, 'far (linear)'),
  },
  lights: {
    ...lightsSchema,
    points: {
      t: 'array',
      label: '点光',
      itemLabel: (l) => l.name,
      create: (existing) => ({
        name: `point_${existing.length + 1}`,
        color: '#ffffff',
        intensity: 2,
        distance: 12,
        decay: 2,
        position: [0, 3, 0],
      }),
      item: {
        name: { t: 'text' },
        color: color(),
        intensity: intensity(50),
        distance: num(0, 100, 0.5),
        decay: num(0, 4, 0.05),
        position: vec(0.25),
      },
    },
  },
  bounds: { _label: '边界 bounds', min: vec(0.5), max: vec(0.5) },
  sky: {
    _label: '天空盒 sky（程序化）',
    enabled: bool(),
    topColor: color(),
    midColor: color(),
    horizonColor: color(),
    bottomColor: color(),
    midHeight: num(0.01, 1, 0.01),
    horizonWidth: num(0.005, 0.5, 0.005),
    sunColor: color(),
    sunSize: num(0, 0.2, 0.001),
    sunIntensity: intensity(20),
    sunGlow: num(0, 3, 0.01),
    sunGlowSpread: num(1, 256, 1, 'sunGlowSpread', '越大光晕越集中'),
    moon: {
      _label: '月亮 / 天体',
      enabled: bool(),
      color: color(),
      azimuth: num(-180, 180, 1),
      elevation: num(-10, 90, 0.5),
      size: num(0.005, 0.5, 0.001),
      softness: num(0, 1, 0.01),
      intensity: num(0, 3, 0.01),
    },
  },
  environment: {
    _label: '环境光 environment',
    mode: select('procedural', 'hdri'),
    hdri: { t: 'text', label: 'hdri 路径', hint: 'public/hdri 下的 .hdr，用 1k/2k，不要 4k' },
    intensity: intensity(5),
    rotationY: num(-Math.PI, Math.PI, 0.01),
    background: bool('background（hdri）'),
    sunIntensity: intensity(20),
  },
  shadows: {
    _label: '阴影（主光）',
    enabled: bool(),
    bias: num(-0.01, 0.01, 0.0001),
    normalBias: num(0, 0.2, 0.001),
    radius: num(0, 10, 0.1, 'radius（soft 档）'),
    cameraSize: num(5, 100, 1, 'cameraSize', '阴影相机覆盖的半边长，越小越清晰'),
    cameraFar: num(10, 500, 5),
  },
  wind: {
    _label: '风动植被 wind',
    enabled: bool(),
    directionDeg: num(-180, 180, 1),
    strength: num(0, 2, 0.01),
    speed: num(0, 5, 0.01),
    scale: num(0, 1, 0.005),
    gustStrength: num(0, 2, 0.01),
    gustFrequency: num(0, 2, 0.01),
    gustScale: num(0, 0.5, 0.005),
    flutterStrength: num(0, 0.5, 0.005),
    flutterFrequency: num(0, 30, 0.1),
    headSway: num(0, 0.5, 0.005),
    stiffnessSource: select('vertexColor', 'localY'),
    stiffnessPower: num(0.5, 4, 0.05),
    confirmGustStrength: num(0, 5, 0.05),
    confirmGustDuration: seconds(),
  },
  sss: {
    _label: '假 SSS',
    enabled: bool('enabled', '可单独关闭以便对比'),
    color: color(),
    scale: num(0, 5, 0.01),
    power: num(0.5, 16, 0.1),
    distortion: num(0, 1, 0.01),
    ambient: num(0, 1, 0.01),
    thickness: num(0, 2, 0.01),
    thicknessSource: select('constant', 'vertexColor'),
    pointLight: { t: 'text', label: 'pointLight（名字）', hint: '参与 SSS 的点光名，仅 full 档生效；留空 = 只算主光' },
  },
  crystal: {
    _label: '晶体 crystal',
    enabled: bool('transmission', '关闭则全部晶体退化为不透明'),
    transmission: num(0, 1, 0.01),
    thickness: num(0, 10, 0.05),
    ior: num(1, 2.333, 0.01),
    roughness: num(0, 1, 0.01),
    attenuationColor: color(),
    attenuationDistance: num(0.01, 20, 0.01),
    glowColor: color(),
    glowIntensity: intensity(10),
    fresnelPower: num(0.5, 10, 0.1),
    mainMinSize: num(0, 20, 0.1, 'mainMinSize', '包围盒最长边 ≥ 此值算主体；mid 档只有主体透射'),
    opaqueEnvMapIntensity: intensity(5),
  },
  water: {
    _label: '水面 water',
    enabled: bool(),
    quality: select('low', 'mid', 'high'),
    level: num(-20, 20, 0.01),
    center: vec(0.5, 'center (x/z)'),
    size: num(1, 1000, 1),
    shallowColor: color(),
    deepColor: color(),
    depthFalloff: num(0.01, 20, 0.01),
    normalScale: num(0.01, 2, 0.01),
    normalStrength: num(0, 2, 0.01),
    flowSpeed: num(0, 2, 0.01),
    flowDirectionDeg: num(-180, 180, 1),
    fresnelPower: num(0.5, 10, 0.1),
    roughness: num(0, 1, 0.01),
    reflectionIntensity: num(0, 2, 0.01),
    reflectionResolution: num(128, 2048, 64, 'reflectionResolution', '实时反射分辨率：最大的性能旋钮，移动端自动减半'),
    reflectionLayers: select('terrain', 'terrain+vegetation'),
    refractionStrength: num(0, 1, 0.01),
    foamWidth: num(0, 3, 0.01),
    foamColor: color(),
    causticsIntensity: num(0, 3, 0.01),
    causticsScale: num(0.01, 2, 0.01),
    causticsSpeed: num(0, 3, 0.01),
    opacity: num(0, 1, 0.01),
    blockDepth: num(0, 5, 0.05, 'blockDepth', '水深超过该值不可行走；0 = 不限制'),
    walkable: bool('walkable', '水面可以行走（在浮岛之间走水）'),
  },
  pond: {
    _label: '贴图池塘 pond（shader 水面）',
    enabled: bool(),
    material: { t: 'text', label: 'material（地形材质名）' },
    maskColor: color('maskColor（贴图里的池塘色）'),
    tolerance: num(0, 0.6, 0.005),
    softness: num(0, 0.3, 0.005),
    color: color(),
    tint: num(0, 1, 0.01),
    roughness: num(0, 1, 0.01),
    normalScale: num(0.05, 5, 0.01),
    normalStrength: num(0, 2, 0.01),
    flowSpeed: num(0, 2, 0.01),
    flowDirectionDeg: num(-180, 180, 1),
    fresnelPower: num(0.5, 10, 0.1),
    reflection: num(0, 3, 0.01),
  },
  grass: {
    _label: '程序化草 grass',
    enabled: bool(),
    mask: { t: 'text', label: 'mask（密度图）' },
    count: num(0, 200000, 1000, 'count（high 档）', '其它档位乘以 Global 档位表的 grass 倍率'),
    radius: num(5, 80, 0.5),
    fadeStart: num(0, 1, 0.01),
    densityThreshold: num(0, 1, 0.01),
    bladeHeight: range(0.02, 2, 0.01),
    bladeWidth: num(0.005, 0.3, 0.001),
    bend: num(0, 1, 0.01),
    baseColor: color(),
    tipColor: color(),
    colorVariation: num(0, 1, 0.01),
    normalUp: num(0, 1, 0.01),
    windInfluence: num(0, 3, 0.01),
    sss: num(0, 3, 0.01),
    receiveShadow: bool(),
  },
  beacon: {
    _label: '引导发光粒子 beacon',
    falloffNear: num(0, 50, 0.5),
    falloffFar: num(1, 200, 1),
    zoneFarIntensity: intensity(5),
    zoneNearIntensity: intensity(5),
    zoneInsideIntensity: intensity(5),
    assetFarIntensity: intensity(5),
    assetNearIntensity: intensity(5),
  },
  particles: {
    t: 'array',
    label: '粒子池',
    itemLabel: (p) => `${p.name}（${p.role}）`,
    create: (existing) => ({ ...DEFAULT_PARTICLE_POOL, name: `pool_${existing.length + 1}` }),
    item: {
      name: { t: 'text' },
      enabled: bool(),
      role: select('ambient', 'beaconZone', 'beaconAsset', 'burst', 'modelEmitters'),
      maxParticles: num(0, 5000, 10),
      emitterShape: select('point', 'box', 'sphere', 'cone', 'disk'),
      emitterRadius: num(0, 50, 0.05),
      emitterSize: vec(0.5, 'emitterSize (box)'),
      emitterAngle: num(0, Math.PI, 0.01),
      emitterHeight: num(0, 20, 0.05),
      emitterDirection: vec(0.05),
      emitterSurfaceOnly: bool(),
      startPositionAsDirection: bool(),
      lifetime: range(0.05, 30, 0.05),
      speed: range(0, 20, 0.01),
      directionSpread: num(0, Math.PI, 0.01),
      gravity: vec(0.01),
      friction: { _label: 'friction', intensity: num(0, 1, 0.01), easing: select('linear', 'easeIn', 'easeOut') },
      turbulence: { _label: 'turbulence', intensity: num(0, 5, 0.01), frequency: num(0, 5, 0.01), speed: num(0, 5, 0.01) },
      size: range(0.001, 3, 0.001),
      colorStart: color(),
      colorEnd: color(),
      intensity: intensity(20),
      blending: select('additive', 'normal'),
      appearance: select('gradient', 'circular', 'square'),
      fadeSizeCurve: curve(),
      fadeOpacityCurve: curve(),
      velocityCurve: curve(),
      rotation: range(-Math.PI, Math.PI, 0.01),
      rotationSpeed: range(-10, 10, 0.01),
      softDistance: num(0, 10, 0.05),
      groundFade: num(0, 5, 0.05),
      followCamera: bool(),
      depthTest: bool(),
      renderOrder: num(-10, 10, 1),
      emitters: {
        t: 'array',
        label: '发射点 emitters',
        itemLabel: (e) => e.name,
        create: (existing) => ({ name: `emitter_${existing.length + 1}`, position: [0, 0, 0], emitCount: 100, delay: 0 }),
        item: { name: { t: 'text' }, position: vec(0.25), emitCount: num(0, 5000, 1), delay: seconds(10) },
      },
    },
  },
  post: postSchema,
  materials: { t: 'materials' },
  audio: {
    _label: '音频（占位）',
    master: { _label: 'master', volume: num(0, 1, 0.01), mute: bool() },
    ambience: { _label: 'ambience', volume: num(0, 1, 0.01), mute: bool(), fadeIn: seconds(10), fadeOut: seconds(10) },
    sfx: { _label: 'sfx', volume: num(0, 1, 0.01), mute: bool(), collectVolume: num(0, 1, 0.01) },
  },
  mobile: {
    _label: '移动端',
    pixelRatioMax: num(0.5, 3, 0.25),
    joystickRadius: num(30, 120, 1),
    joystickSensitivity: num(0.2, 3, 0.05),
    lookSensitivity: num(0.2, 5, 0.05),
  },
  placeholder: {
    _label: '占位',
    groundColor: color(),
    groundSize: num(10, 200, 1),
    zoneColor: color(),
    zoneOpacity: num(0, 1, 0.01, 'zoneOpacity', '采集区地面圈，0 = 隐藏'),
    assetRoughness: num(0, 1, 0.01),
    assetMetalness: num(0, 1, 0.01),
  },
  flow: {
    _label: '采集流程',
    zoneCenter: vec(0.5, 'zoneCenter (x/z)'),
    zoneRadius: num(1, 40, 0.1),
    proximity: num(0.5, 10, 0.1),
    othersFadeOut: bool('othersFadeOut', '确认后其余三个资产是否同步淡出'),
    selectGlowDuration: seconds(),
    fadeDuration: seconds(),
    resolveDelay: seconds(),
    idleEmissive: intensity(10),
    activeEmissive: intensity(10),
    inspectEmissive: intensity(10),
    selectedEmissive: intensity(20),
    breatheSpeed: num(0, 10, 0.05),
    breatheDepth: num(0, 1, 0.01),
    emissiveDamping: num(0, 1, 0.01),
    spinSpeed: num(0, 5, 0.05),
    assetLift: num(0, 5, 0.05),
    floatAmplitude: num(0, 1, 0.01),
    floatSpeed: num(0, 10, 0.05),
    clickDragThreshold: num(0, 30, 1),
  },
}

const slotSchema = {
  position: vec(0.05),
  rotation: vec(0.01),
  scale: num(0.1, 5, 0.01),
  autoFit: bool('autoFit', '开启时按包围盒最长边缩放到 fitSize，关闭时用资产的 specimenScale'),
  fitSize: num(0.1, 5, 0.01),
}

export const ENDING_SCHEMA: SchemaFor<EndingConfig> = {
  version: hidden,
  scene: hidden,
  camera: { _label: '相机', fov: num(10, 90, 0.5), position: vec(0.1), lookAt: vec(0.1) },
  background: color('背景色'),
  lights: lightsSchema,
  frame: {
    _label: '画框',
    mode: { t: 'select', options: ['3d', 'plane'] },
    color: color(),
    metalness: num(0, 1, 0.01),
    roughness: num(0, 1, 0.01),
    backColor: color(),
    backRoughness: num(0, 1, 0.01),
    size: vec(0.05),
    border: num(0, 2, 0.01),
    planeDepth: num(-5, 5, 0.01),
  },
  slots: {
    _label: '标本 slot',
    slotA: { _label: 'slotA（洞穴）', ...slotSchema },
    slotB: { _label: 'slotB（海洋）', ...slotSchema },
    slotC: { _label: 'slotC（花园）', ...slotSchema },
  },
  specimen: {
    _label: '标本材质',
    emissiveIntensity: intensity(5),
    roughness: num(0, 1, 0.01),
    metalness: num(0, 1, 0.01),
    hoverEmissive: intensity(5),
  },
  reveal: {
    _label: '入场',
    fadeDuration: seconds(),
    textDelay: seconds(),
    boxScaleFrom: num(0.5, 1.5, 0.01),
    boxDuration: seconds(),
    specimenDuration: seconds(),
    specimenStagger: seconds(),
    specimenFrom: vec(0.05, 'specimenFrom（相对 slot）'),
  },
  environment: {
    _label: '环境光（影棚）',
    intensity: intensity(5),
    rotationY: num(-Math.PI, Math.PI, 0.01),
    topColor: color(),
    bottomColor: color(),
    keyIntensity: intensity(20),
    keySize: num(0.5, 20, 0.1),
  },
  shadows: {
    _label: '阴影（主光）',
    enabled: bool(),
    bias: num(-0.01, 0.01, 0.0001),
    normalBias: num(0, 0.2, 0.001),
    radius: num(0, 10, 0.1, 'radius（soft 档）'),
    cameraSize: num(1, 30, 0.5),
    cameraFar: num(5, 100, 1),
  },
  post: postSchema,
  interaction: {
    _label: '交互（旋转 / 缩放）',
    yawLimitDeg: num(0, 90, 1),
    pitchLimitDeg: num(0, 60, 1),
    dragSensitivity: num(0.01, 1, 0.01),
    damping: num(0, 1, 0.01),
    zoomMin: num(0.3, 1, 0.01),
    zoomMax: num(1, 3, 0.01),
    zoomSpeed: num(0.0001, 0.005, 0.0001),
    returnDelay: seconds(20),
    idleSwayDeg: num(0, 10, 0.1),
    idleSwaySpeed: num(0, 3, 0.01),
  },
  photo: {
    _label: '照片导出',
    scale: num(1, 4, 0.5),
    margin: num(0, 400, 1),
    background: color(),
    borderWidth: num(0, 40, 1),
    borderColor: color(),
    includeText: bool(),
    titleSize: num(10, 120, 1),
    descSize: num(8, 60, 1),
    textColor: color(),
    descColor: color(),
    textGap: num(0, 200, 1),
    includeLogo: bool(),
    logo: { t: 'text', label: 'logo（public 下路径）' },
    logoSize: num(16, 400, 1),
  },
}

const tierSchema = (label: string) => ({
  _label: label,
  pixelRatioMax: num(0.5, 3, 0.25),
  water: { t: 'select', options: ['low', 'mid', 'high'] } as SelectLeaf<QualityTier>,
  windLayers: num(1, 3, 1),
  sss: { t: 'select', options: ['off', 'single', 'full'] } as SelectLeaf<TierSettings['sss']>,
  crystal: { t: 'select', options: ['none', 'main', 'all'] } as SelectLeaf<TierSettings['crystal']>,
  shadows: { t: 'select', options: ['off', 'on', 'soft'] } as SelectLeaf<TierSettings['shadows']>,
  shadowMapSize: num(256, 4096, 256),
  particles: num(0, 1, 0.05),
  grass: num(0, 1, 0.05),
  post: { t: 'select', options: ['basic', 'mid', 'full'] } as SelectLeaf<TierSettings['post']>,
})

export const GLOBAL_SCHEMA: SchemaFor<GlobalConfig> = {
  version: hidden,
  scene: hidden,
  transition: { _label: '页面过场', fadeOut: seconds(), fadeIn: seconds(), color: color() },
  quality: {
    _label: '质量档位',
    desktopDefault: { t: 'select', options: ['low', 'mid', 'high'] },
    mobileDefault: { t: 'select', options: ['low', 'mid', 'high'] },
    tiers: { _label: '各档位上限', low: tierSchema('low'), mid: tierSchema('mid'), high: tierSchema('high') },
    frameGuard: {
      _label: '帧率守门（自动降档）',
      enabled: bool('enabled', '默认是否开启自动降档；面板「调试」里可临时锁定档位'),
      targetFpsDesktop: num(20, 144, 1),
      targetFpsMobile: num(15, 120, 1),
      threshold: num(0.3, 1, 0.05, 'threshold', '低于目标帧率的这个比例才算不达标'),
      window: seconds(10),
      warmup: seconds(10),
    },
  },
}
