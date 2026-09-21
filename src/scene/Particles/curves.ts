import { DataTexture, DataUtils, HalfFloatType, LinearFilter, RGBAFormat } from 'three'
import type { Vec4 } from '../../config/schema'

// 生命周期曲线烘成纹理（spec §5.3D）：shader 里按 progress 采样一次，比多段 mix 便宜，精度也不受控制点数量限制。
//   R = size 曲线，G = opacity 曲线，B = velocity 曲线，A = velocity 从 0 到 p 的积分（算位移用）

const SAMPLES = 64

/** 1D 三次贝塞尔：控制点 x 均匀分布，所以 x(t) = t，只需求 y */
export function bezier([a, b, c, d]: Vec4, t: number) {
  const u = 1 - t
  return u * u * u * a + 3 * u * u * t * b + 3 * u * t * t * c + t * t * t * d
}

export function bakeCurves(size: Vec4, opacity: Vec4, velocity: Vec4): DataTexture {
  const data = new Uint16Array(SAMPLES * 4)
  const step = 1 / (SAMPLES - 1)
  let integral = 0
  for (let i = 0; i < SAMPLES; i++) {
    const p = i * step
    const v = bezier(velocity, p)
    if (i > 0) integral += ((v + bezier(velocity, p - step)) / 2) * step
    data[i * 4] = DataUtils.toHalfFloat(bezier(size, p))
    data[i * 4 + 1] = DataUtils.toHalfFloat(Math.max(0, bezier(opacity, p)))
    data[i * 4 + 2] = DataUtils.toHalfFloat(v)
    data[i * 4 + 3] = DataUtils.toHalfFloat(integral)
  }
  const tex = new DataTexture(data, SAMPLES, 1, RGBAFormat, HalfFloatType)
  tex.magFilter = LinearFilter
  tex.minFilter = LinearFilter
  tex.needsUpdate = true
  return tex
}
