import { useFrame } from '@react-three/fiber'
import { Color, Quaternion, Vector3, type Material, type Object3D } from 'three'
import type { SceneConfig } from '../config/schema'
import { getSceneCfg } from '../state/useConfigStore'
import { shared } from './uniforms'

// 场景人物的 idle 动画（config.figure）：全部在顶点着色器里做，不做物理模拟，开销只是每个顶点几次三角函数。
// 数据来自 scripts/build-character.mjs：
//   _idle 顶点属性 = (呼吸权重, 头部权重, 布料权重, 眨眼权重)，前两项取自原骨骼的蒙皮权重；眨眼权重 + 上眼皮 / - 下眼皮
//   轴心节点 userData：idleNeck / idleNodAxis = 颈部位置 / 点头轴，idleEyeLeft / idleEyeRight / idleBlinkAxis = 眼球中心 / 眨眼转轴，
//   idleHeadForward = 脸朝向
//   （都在轴心节点的局部空间，也就是 mesh 的局部空间）
// 顺序（都在静止姿势下算，最后才绕颈部转）：
//   眨眼：眼皮绕最近的眼球中心转；间隔带随机抖动，闭快睁慢
//   呼吸：胸腔沿法线起伏
//   头部：绕颈部轻微转头 + 点头，再叠加「看观众」的转动（头发、头饰蒙在头骨上，一起动；颈部权重 0.5，只转一半）
//   布料：两组斜向正弦叠出的缓慢波纹
// 旋转同时作用在法线上（不然转头后脸上的明暗还是原来的）。
// 「看观众」：useFigureLook() 每帧在 JS 里算头要转多少（限制在最大角度内、平滑过渡），通过 uniform 传给着色器。
//   眼球不单独转（试过对准观众，眼神很吓人），跟着头一起动。
// 皮肤（char_Head / Body / Arms / Legs / Toenails）：片元里在贴图之后调亮度 / 饱和度 / 色调，
//   各场景光照不同（花园偏粉、海洋偏冷暗），人物肤色按场景单独调，不动场景光照。
// 只认 char_ 前缀的材质（build-character 统一改的名）。场景里假定只有一个人物。

export const figureUniforms = {
  uFigureEnabled: { value: 0 },
  uFigureNeck: { value: new Vector3() },
  uFigureNodAxis: { value: new Vector3(1, 0, 0) },
  uFigureBreathAmplitude: { value: 0 },
  uFigureBreathRate: { value: 0.2 },
  uFigureHeadSway: { value: 0 },
  uFigureHeadRate: { value: 0.07 },
  uFigureClothAmplitude: { value: 0 },
  uFigureClothScale: { value: 1 },
  uFigureClothSpeed: { value: 0.25 },
  uFigureEyeLeft: { value: new Vector3() },
  uFigureEyeRight: { value: new Vector3() },
  uFigureBlinkAxis: { value: new Vector3(1, 0, 0) },
  uFigureBlinkInterval: { value: 0 },
  uFigureBlinkDuration: { value: 0.3 },
  uFigureBlinkAngle: { value: 0 },
  // 看观众：头绕颈部转的轴角
  uFigureLookAxis: { value: new Vector3(0, 1, 0) },
  uFigureLookAngle: { value: 0 },
  // 皮肤
  uFigureSkinBrightness: { value: 1 },
  uFigureSkinSaturation: { value: 1 },
  uFigureSkinTint: { value: new Color('#ffffff') },
}

export const isFigureMaterial = (name: string) => name.startsWith('char_')
/** 皮肤材质（Daz 角色的 Victoria 9 HD 皮肤，build-character 改名后） */
const isFigureSkin = (name: string) => /^char_(Head|Body|Arms|Legs|Toenails)$/.test(name)

export function updateFigureUniforms(cfg: SceneConfig) {
  const f = cfg.figure
  const u = figureUniforms
  u.uFigureEnabled.value = f?.enabled ? 1 : 0
  if (!f) return
  u.uFigureBreathAmplitude.value = f.breathAmplitude
  u.uFigureBreathRate.value = f.breathRate
  u.uFigureHeadSway.value = f.headSway
  u.uFigureHeadRate.value = f.headRate
  u.uFigureClothAmplitude.value = f.clothAmplitude
  u.uFigureClothScale.value = f.clothScale
  u.uFigureClothSpeed.value = f.clothSpeed
  u.uFigureBlinkInterval.value = f.blinkInterval
  u.uFigureBlinkDuration.value = f.blinkDuration
  u.uFigureBlinkAngle.value = f.blinkAngle
  u.uFigureSkinBrightness.value = f.skinBrightness ?? 1
  u.uFigureSkinSaturation.value = f.skinSaturation ?? 1
  u.uFigureSkinTint.value.set(f.skinTint ?? '#ffffff')
}

// ---------------------------------------------------------------------------
// 骨架数据（build-character 写在轴心节点的 extras 里）

const rig = {
  node: null as Object3D | null,
  forward: new Vector3(0, 0, 1),
  /** 有没有单独的眼球（洞穴人物是合成一个网格的，没有）：没有就不眨眼，看观众时以颈部为头的位置 */
  hasEyes: false,
}

type RigData = Partial<
  Record<
    | 'idleNeck'
    | 'idleNodAxis'
    | 'idleEyeLeft'
    | 'idleEyeRight'
    | 'idleBlinkAxis'
    | 'idleHeadForward',
    number[]
  >
>

/** 读人物的骨架数据；返回注销函数（模型卸载后不再看观众） */
export function registerFigureRig(root: Object3D) {
  let found: Object3D | null = null
  // 场景里只有一个人物：先清掉上一个人物留下的眼睛数据
  rig.hasEyes = false
  root.traverse((o) => {
    const d = o.userData as RigData
    const u = figureUniforms
    if (d.idleNeck) u.uFigureNeck.value.fromArray(d.idleNeck)
    if (d.idleNodAxis) u.uFigureNodAxis.value.fromArray(d.idleNodAxis)
    if (d.idleEyeLeft) u.uFigureEyeLeft.value.fromArray(d.idleEyeLeft)
    if (d.idleEyeRight) u.uFigureEyeRight.value.fromArray(d.idleEyeRight)
    if (d.idleEyeLeft && d.idleEyeRight) rig.hasEyes = true
    if (d.idleBlinkAxis) u.uFigureBlinkAxis.value.fromArray(d.idleBlinkAxis)
    if (d.idleHeadForward) {
      rig.forward.fromArray(d.idleHeadForward)
      found = o
    }
  })
  if (found) rig.node = found
  return () => {
    if (rig.node === found) rig.node = null
  }
}

// ---------------------------------------------------------------------------
// 看观众：随机间隔转头看一会儿（观众走动时一直跟着看），再慢慢转回去

const IDENTITY = new Quaternion()
const look = {
  active: false,
  timer: 3,
  head: new Quaternion(),
}
const camLocal = new Vector3()
const origin = new Vector3()
const originWorld = new Vector3()
const toCam = new Vector3()
const target = new Quaternion()
const full = new Quaternion()

/** from → to 的旋转，转角超过 max 时按比例截到 max */
function clampedRotation(from: Vector3, to: Vector3, max: number, out: Quaternion) {
  full.setFromUnitVectors(from, to)
  const angle = 2 * Math.acos(Math.min(1, Math.abs(full.w)))
  // slerpQuaternions 会先把 out 覆盖成第一个参数，所以完整旋转要放在另一个对象里
  return out.slerpQuaternions(IDENTITY, full, angle > max ? max / angle : 1)
}

function writeAxisAngle(q: Quaternion, axis: { value: Vector3 }, angle: { value: number }) {
  const w = Math.min(1, Math.max(-1, q.w))
  const s = Math.sqrt(1 - w * w)
  if (s < 1e-5) {
    angle.value = 0
    return
  }
  axis.value.set(q.x / s, q.y / s, q.z / s)
  angle.value = 2 * Math.acos(w)
}

/** 放在场景 Canvas 内（EnvModel 里调用） */
export function useFigureLook() {
  useFrame(({ camera }, delta) => {
    const f = getSceneCfg().figure
    const u = figureUniforms
    const node = rig.node
    const dt = Math.min(delta, 0.1)
    if (!node || !f?.enabled || f.lookInterval <= 0) {
      look.active = false
      look.timer = 1
      look.head.identity()
      u.uFigureLookAngle.value = 0
      return
    }

    // 观众（相机）换到人物的局部空间；以两眼中点为头的位置（没有眼球就用颈部）
    camLocal.copy(camera.position)
    node.worldToLocal(camLocal)
    if (rig.hasEyes) origin.addVectors(u.uFigureEyeLeft.value, u.uFigureEyeRight.value).multiplyScalar(0.5)
    else origin.copy(u.uFigureNeck.value)
    originWorld.copy(origin)
    node.localToWorld(originWorld)
    toCam.subVectors(camLocal, origin).normalize()
    // 太远、或者在她身后（脖子拧不过去）就不看
    const canSee =
      camera.position.distanceTo(originWorld) < f.lookDistance && rig.forward.angleTo(toCam) < f.lookMaxAngle + 0.9

    const wait = () => f.lookInterval * (0.5 + Math.random())
    // 看着看着观众走远 / 绕到身后：转回去，重新等一个间隔
    if (look.active && !canSee) {
      look.active = false
      look.timer = wait()
    }
    look.timer = Math.min(look.timer - dt, look.active ? f.lookDuration * 1.3 : f.lookInterval * 1.5)
    if (look.timer <= 0) {
      look.active = !look.active && canSee
      look.timer = look.active ? f.lookDuration * (0.7 + 0.6 * Math.random()) : wait()
    }

    // 头：脸朝向转向观众，截到最大角度，平滑追过去
    if (look.active) clampedRotation(rig.forward, toCam, f.lookMaxAngle, target)
    else target.identity()
    look.head.slerp(target, 1 - Math.exp(-f.lookSpeed * dt))
    writeAxisAngle(look.head, u.uFigureLookAxis, u.uFigureLookAngle)
  })
}

// ---------------------------------------------------------------------------
// 着色器补丁

const vertexHead = /* glsl */ `
attribute vec4 _idle;
uniform float uTime;
uniform float uFigureEnabled;
uniform vec3 uFigureNeck;
uniform vec3 uFigureNodAxis;
uniform float uFigureBreathAmplitude;
uniform float uFigureBreathRate;
uniform float uFigureHeadSway;
uniform float uFigureHeadRate;
uniform float uFigureClothAmplitude;
uniform float uFigureClothScale;
uniform float uFigureClothSpeed;
uniform vec3 uFigureEyeLeft;
uniform vec3 uFigureEyeRight;
uniform vec3 uFigureBlinkAxis;
uniform float uFigureBlinkInterval;
uniform float uFigureBlinkDuration;
uniform float uFigureBlinkAngle;
uniform vec3 uFigureLookAxis;
uniform float uFigureLookAngle;
// 绕单位轴 axis 旋转 angle（Rodrigues）
vec3 edenRotate(vec3 v, vec3 axis, float angle) {
  float c = cos(angle), s = sin(angle);
  return v * c + cross(axis, v) * s + axis * dot(axis, v) * (1.0 - c);
}
// 眨眼进度 0（睁）..1（闭）：每个间隔里在随机位置眨一次，闭眼占 35%，睁眼慢一些
float edenBlink(float t) {
  if (uFigureBlinkInterval <= 0.0 || uFigureBlinkDuration <= 0.0) return 0.0;
  float n = floor(t / uFigureBlinkInterval);
  float jitter = fract(sin(n * 12.9898 + 4.1) * 43758.5453);
  float x = (t - (n + 0.1 + 0.6 * jitter) * uFigureBlinkInterval) / uFigureBlinkDuration;
  if (x <= 0.0 || x >= 1.0) return 0.0;
  return x < 0.35 ? smoothstep(0.0, 0.35, x) : 1.0 - smoothstep(0.35, 1.0, x);
}
`

// 接在 beginnormal_vertex 后面：位置和法线一起变形（法线随后才被 defaultnormal_vertex 用掉）
const vertexDeform = /* glsl */ `
vec3 edenPos = position;
if (uFigureEnabled > 0.5) {
  vec3 restNormal = objectNormal;
  // 眨眼：眼皮绕最近的眼球中心转
  if (_idle.w != 0.0) {
    vec3 eye = distance(position, uFigureEyeLeft) < distance(position, uFigureEyeRight) ? uFigureEyeLeft : uFigureEyeRight;
    float blink = edenBlink(uTime);
    if (blink > 0.0) {
      float a = uFigureBlinkAngle * _idle.w * blink;
      edenPos = eye + edenRotate(edenPos - eye, uFigureBlinkAxis, a);
      objectNormal = edenRotate(objectNormal, uFigureBlinkAxis, a);
    }
  }
  // 呼吸：吸气慢、呼气略快（sin 抬到 0..1 再开方，峰值处停留更久）
  float breath = sqrt(0.5 + 0.5 * sin(uTime * 6.2831853 * uFigureBreathRate));
  edenPos += restNormal * (_idle.x * uFigureBreathAmplitude * breath);
  // 头部：两种不成整数比的频率叠加，不会一眼看出循环；点头跟呼吸带一点；最后叠加看观众
  if (_idle.y > 0.0) {
    float t = uTime * 6.2831853 * uFigureHeadRate;
    float yaw = uFigureHeadSway * _idle.y * (0.7 * sin(t) + 0.3 * sin(t * 2.31 + 1.7));
    float nod = uFigureHeadSway * _idle.y * (0.6 * sin(t * 0.73 + 0.9) + 0.4 * (breath - 0.5));
    float lookA = uFigureLookAngle * _idle.y;
    vec3 p = edenPos - uFigureNeck;
    p = edenRotate(p, uFigureNodAxis, nod);
    p = edenRotate(p, vec3(0.0, 1.0, 0.0), yaw);
    p = edenRotate(p, uFigureLookAxis, lookA);
    edenPos = uFigureNeck + p;
    objectNormal = edenRotate(objectNormal, uFigureNodAxis, nod);
    objectNormal = edenRotate(objectNormal, vec3(0.0, 1.0, 0.0), yaw);
    objectNormal = edenRotate(objectNormal, uFigureLookAxis, lookA);
  }
  // 布料：两组方向不同的行波叠加，沿法线推
  if (_idle.z > 0.0) {
    vec3 q = edenPos * uFigureClothScale;
    float t = uTime * uFigureClothSpeed * 6.2831853;
    float w = 0.6 * sin(dot(q, vec3(1.3, 0.5, 0.9)) + t) + 0.4 * sin(dot(q, vec3(-0.8, 1.1, 1.7)) - t * 1.37);
    edenPos += restNormal * (_idle.z * uFigureClothAmplitude * w);
  }
}
`

// 皮肤：贴图采样之后（diffuseColor 在线性空间），先按亮度去饱和，再乘亮度和色调。
// 去饱和只作用在接近肤色的色相（橙红，约 13° 上下）：眼影、唇彩、蓝绿色妆偏离肤色，保持原样（腮红色相接近，会淡一点）
const fragmentSkinHead = /* glsl */ `
uniform float uFigureSkinBrightness;
uniform float uFigureSkinSaturation;
uniform vec3 uFigureSkinTint;
`
const fragmentSkin = /* glsl */ `
{
  vec3 c = diffuseColor.rgb;
  float mx = max(c.r, max(c.g, c.b));
  float d = mx - min(c.r, min(c.g, c.b));
  float hue = 0.0;
  if (d > 1e-5) {
    if (mx == c.r) hue = mod((c.g - c.b) / d, 6.0);
    else if (mx == c.g) hue = (c.b - c.r) / d + 2.0;
    else hue = (c.r - c.g) / d + 4.0;
    hue /= 6.0;
  }
  float hueDist = min(abs(hue - 0.035), 1.0 - abs(hue - 0.035));
  float skinLike = 1.0 - smoothstep(0.04, 0.08, hueDist);
  float l = dot(c, vec3(0.2126, 0.7152, 0.0722));
  diffuseColor.rgb = mix(vec3(l), c, mix(1.0, uFigureSkinSaturation, skinLike)) * uFigureSkinBrightness * uFigureSkinTint;
}
`

// Symbol.for：开发时热更新会把本模块再加载一份，全局共享的标记才能防止同一材质被补两遍（重复声明，编译失败）
const PATCHED = Symbol.for('eden-figure')

export function patchFigure(material: Material) {
  const m = material as Material & { [PATCHED]?: true }
  if (m[PATCHED]) return
  m[PATCHED] = true
  const skin = isFigureSkin(m.name)
  const prev = m.onBeforeCompile
  m.onBeforeCompile = (shader, renderer) => {
    prev?.call(m, shader, renderer)
    Object.assign(shader.uniforms, { uTime: shared.uTime, ...figureUniforms })
    // 其它补丁（焦散）也会声明 uTime：只在还没声明时补上
    const head = shader.vertexShader.includes('uniform float uTime;') ? vertexHead.replace('uniform float uTime;\n', '') : vertexHead
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>\n${head}`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>\n${vertexDeform}`)
      .replace('#include <begin_vertex>', '#include <begin_vertex>\ntransformed = edenPos;')
    if (skin) {
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>\n${fragmentSkinHead}`)
        .replace('#include <map_fragment>', `#include <map_fragment>\n${fragmentSkin}`)
    }
  }
  const prevKey = m.customProgramCacheKey?.bind(m)
  m.customProgramCacheKey = () => `${prevKey?.() ?? ''}|eden-figure${skin ? '-skin' : ''}`
  m.needsUpdate = true
}

// DEV：暴露给自动化测试脚本
if (import.meta.env.DEV) (window as unknown as Record<string, unknown>).__figure = { uniforms: figureUniforms, look, rig }
