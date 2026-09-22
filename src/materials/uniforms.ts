import { useFrame } from '@react-three/fiber'
import { Color, Vector2, Vector3 } from 'three'
import { getSceneCfg } from '../state/useConfigStore'
import { getTier } from '../state/useQualityStore'
import { updateDetailUniforms } from './detail'
import { updatePondUniforms } from './pond'

// 场景级共享 uniform 注册表（spec §5.2）：所有自定义材质引用同一批 uniform 对象，
// 由 <SharedUniformDriver /> 一个 useFrame 统一推送，不让每个材质各跑一个。

export const shared = {
  uTime: { value: 0 },
  // 风
  uWindDir: { value: new Vector2(1, 0) },
  uWindStrength: { value: 0 },
  uWindSpeed: { value: 1 },
  uWindScale: { value: 0.05 },
  uGustStrength: { value: 0 },
  uGustFrequency: { value: 0.3 },
  uGustScale: { value: 0.05 },
  uFlutterStrength: { value: 0 },
  uFlutterFrequency: { value: 8 },
  uHeadSway: { value: 0 },
  uWindLayers: { value: 3 },
  uGustBoost: { value: 0 },
  uStiffnessPower: { value: 1.5 },
  // 主光（SSS 用）
  uSunDir: { value: new Vector3(0, 1, 0) },
  uSunColor: { value: new Color('#ffffff') },
  // 假 SSS
  uSSSEnabled: { value: 1 },
  uSSSColor: { value: new Color('#ffffff') },
  uSSSScale: { value: 1 },
  uSSSPower: { value: 4 },
  uSSSDistortion: { value: 0.2 },
  uSSSAmbient: { value: 0.05 },
  uSSSThickness: { value: 1 },
  uSSSPointEnabled: { value: 0 },
  uSSSPointPos: { value: new Vector3() },
  uSSSPointColor: { value: new Color('#000000') },
  // 晶体
  uCrystalGlowColor: { value: new Color('#ffffff') },
  uCrystalGlowIntensity: { value: 0 },
  uCrystalFresnelPower: { value: 3 },
  // 焦散（水下地形）
  uWaterLevel: { value: -1e4 },
  uCausticsEnabled: { value: 0 },
  uCausticsIntensity: { value: 0 },
  uCausticsScale: { value: 0.3 },
  uCausticsSpeed: { value: 0.5 },
}

// ---- 采集确认时的「一阵风」----
let gustStartedAt = -1e9
export function triggerConfirmGust() {
  gustStartedAt = shared.uTime.value
}

const DEG = Math.PI / 180

/** 放在场景 Canvas 内：每帧从 config 同步共享 uniform */
export function SharedUniformDriver() {
  useFrame((state) => {
    const t = state.clock.elapsedTime
    shared.uTime.value = t
    const cfg = getSceneCfg()
    const tier = getTier()

    // 风
    const w = cfg.wind
    const on = w.enabled ? 1 : 0
    shared.uWindDir.value.set(Math.cos(w.directionDeg * DEG), Math.sin(w.directionDeg * DEG))
    shared.uWindStrength.value = w.strength * on
    shared.uWindSpeed.value = w.speed
    shared.uWindScale.value = w.scale
    shared.uGustStrength.value = w.gustStrength * on
    shared.uGustFrequency.value = w.gustFrequency
    shared.uGustScale.value = w.gustScale
    shared.uFlutterStrength.value = w.flutterStrength * on
    shared.uFlutterFrequency.value = w.flutterFrequency
    shared.uHeadSway.value = w.headSway * on
    shared.uWindLayers.value = tier.windLayers
    shared.uStiffnessPower.value = w.stiffnessPower
    const g = (t - gustStartedAt) / Math.max(w.confirmGustDuration, 0.01)
    // 一阵风：快速升起、平滑衰减
    shared.uGustBoost.value = g >= 0 && g < 1 ? w.confirmGustStrength * Math.sin(Math.PI * Math.sqrt(g)) : 0

    // 主光方向（从目标指向光源）
    const d = cfg.lights.directional
    shared.uSunDir.value.set(...d.position).normalize()
    shared.uSunColor.value.set(d.color).multiplyScalar(d.intensity)

    // 假 SSS：off 档关闭；full 档额外算一盏点光
    const s = cfg.sss
    shared.uSSSEnabled.value = s.enabled && tier.sss !== 'off' ? 1 : 0
    shared.uSSSColor.value.set(s.color)
    shared.uSSSScale.value = s.scale
    shared.uSSSPower.value = s.power
    shared.uSSSDistortion.value = s.distortion
    shared.uSSSAmbient.value = s.ambient
    shared.uSSSThickness.value = s.thickness
    const point = tier.sss === 'full' && s.pointLight ? cfg.lights.points.find((p) => p.name === s.pointLight) : undefined
    shared.uSSSPointEnabled.value = point ? 1 : 0
    if (point) {
      shared.uSSSPointPos.value.set(...point.position)
      shared.uSSSPointColor.value.set(point.color).multiplyScalar(point.intensity * 0.1)
    }

    // 晶体
    const c = cfg.crystal
    shared.uCrystalGlowColor.value.set(c.glowColor)
    shared.uCrystalGlowIntensity.value = c.glowIntensity
    shared.uCrystalFresnelPower.value = c.fresnelPower

    // 焦散：只在 high 档水面开启时投射
    const water = cfg.water
    const causticsOn = water.enabled && tier.water === 'high' && water.quality === 'high' && water.causticsIntensity > 0
    shared.uWaterLevel.value = water.enabled ? water.level : -1e4
    shared.uCausticsEnabled.value = causticsOn ? 1 : 0
    shared.uCausticsIntensity.value = water.causticsIntensity
    shared.uCausticsScale.value = water.causticsScale
    shared.uCausticsSpeed.value = water.causticsSpeed

    updatePondUniforms(cfg)
    updateDetailUniforms(cfg, tier)
  })
  return null
}
