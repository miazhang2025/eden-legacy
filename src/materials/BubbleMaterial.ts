import { BufferAttribute, FrontSide, type BufferGeometry, type Material, type Mesh, type MeshPhysicalMaterial } from 'three'
import type { BubbleConfig } from '../config/schema'
import { createCSM, type EdenCSM } from './csm'
import { shared } from './uniforms'

// 泡泡（ocean）：近乎透明的薄膜。不用 transmission（又贵又像玻璃），而是普通透明混合：
//   正对视线处几乎透明、边缘按菲涅尔变实（centerOpacity → rimOpacity），贴图（烘焙反射）只淡淡叠一层，
//   加 physical 的 iridescence 做薄膜干涉的彩虹色。每个泡泡按自己的相位上下浮动。

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform float uBubbleBobAmplitude;
  uniform float uBubbleBobSpeed;
  attribute float aEdenBubblePhase;
  varying vec3 vEdenBubbleNormal;
  varying vec3 vEdenBubbleView;

  float edenBubbleHash(vec3 p) {
    return fract(sin(dot(p, vec3(12.9898, 78.233, 37.719))) * 43758.5453);
  }

  void main() {
    mat4 model = modelMatrix;
    #ifdef USE_INSTANCING
      model = modelMatrix * instanceMatrix;
    #endif
    // 相位：几何里每个泡泡（连通块）一个 + 每个 mesh / 实例的位置
    float ph = aEdenBubblePhase + edenBubbleHash(model[3].xyz);
    float speed = uBubbleBobSpeed * (0.75 + 0.5 * fract(ph * 7.31));
    float lift = sin(uTime * speed + ph * 6.2832) * uBubbleBobAmplitude;
    // 世界坐标的竖直位移换回本地坐标（节点可能带旋转 / 均匀缩放）
    vec3 upLocal = transpose(mat3(model)) * vec3(0.0, 1.0, 0.0);
    csm_Position = position + upLocal * (lift / max(dot(upLocal, upLocal), 1e-6));
    vEdenBubbleNormal = normalize(mat3(model) * normal);
    vEdenBubbleView = cameraPosition - (model * vec4(csm_Position, 1.0)).xyz;
  }
`

const fragmentShader = /* glsl */ `
  uniform vec3 uBubbleTint;
  uniform float uBubbleTextureStrength;
  uniform float uBubbleCenterOpacity;
  uniform float uBubbleRimOpacity;
  uniform float uBubbleFresnelPower;
  uniform vec3 uBubbleRimColor;
  uniform float uBubbleRimGlow;
  varying vec3 vEdenBubbleNormal;
  varying vec3 vEdenBubbleView;

  void main() {
    vec3 N = normalize(vEdenBubbleNormal);
    vec3 V = normalize(vEdenBubbleView);
    float fresnel = pow(1.0 - clamp(abs(dot(N, V)), 0.0, 1.0), uBubbleFresnelPower);
    // 贴图是烘焙的环境反射：按比例淡淡叠在泡泡色上
    vec3 col = mix(uBubbleTint, csm_DiffuseColor.rgb, uBubbleTextureStrength);
    float alpha = mix(uBubbleCenterOpacity, uBubbleRimOpacity, fresnel) * csm_DiffuseColor.a;
    csm_DiffuseColor = vec4(col, alpha);
    csm_Emissive += uBubbleRimColor * uBubbleRimGlow * fresnel;
  }
`

export function createBubbleMaterial(source: Material): EdenCSM {
  const m = createCSM('physical', source, {
    vertexShader,
    fragmentShader,
    uniforms: shared,
    cacheKey: 'eden-bubble-v1',
  })
  // 透明薄膜不写深度，免得泡泡之间互相挡住；只画正面（背面再叠一层边缘会发白）
  m.transparent = true
  m.depthWrite = false
  m.side = FrontSide
  m.__edenRole = 'bubble'
  return m
}

/** 不在 MaterialOverride 里的 physical 属性：薄膜干涉 */
export function applyBubbleValues(m: Material, c: BubbleConfig) {
  const p = m as MeshPhysicalMaterial
  if (!p.isMeshPhysicalMaterial) return
  if ((p.iridescence > 0) !== (c.iridescence > 0)) p.needsUpdate = true
  p.iridescence = c.iridescence
  p.iridescenceIOR = c.iridescenceIOR
  p.iridescenceThicknessRange = [c.filmThicknessMin, c.filmThicknessMax]
  p.depthWrite = false
}

/**
 * 美术把一片泡泡合成了一个 mesh：按「位置相同的顶点焊在一起 + 三角形连通」分出各个泡泡。
 * 返回每个顶点所属泡泡的编号（0..count-1），以及每个泡泡的中心（几何局部坐标）。
 */
export function bubbleComponents(geo: BufferGeometry): { of: Int32Array; centers: [number, number, number][] } {
  const pos = geo.getAttribute('position')
  const n = pos.count
  const parent = new Int32Array(n)
  for (let i = 0; i < n; i++) parent[i] = i
  const find = (i: number) => {
    while (parent[i] !== i) i = parent[i] = parent[parent[i]]
    return i
  }
  const union = (a: number, b: number) => void (parent[find(a)] = find(b))
  // UV 接缝处同一位置有多个顶点
  const seen = new Map<string, number>()
  for (let i = 0; i < n; i++) {
    const k = `${pos.getX(i).toFixed(4)},${pos.getY(i).toFixed(4)},${pos.getZ(i).toFixed(4)}`
    const j = seen.get(k)
    if (j === undefined) seen.set(k, i)
    else union(i, j)
  }
  const index = geo.getIndex()
  if (index) {
    for (let t = 0; t < index.count; t += 3) {
      union(index.getX(t), index.getX(t + 1))
      union(index.getX(t), index.getX(t + 2))
    }
  } else {
    for (let t = 0; t < n; t += 3) {
      union(t, t + 1)
      union(t, t + 2)
    }
  }
  const id = new Map<number, number>()
  const sums: [number, number, number, number][] = []
  const of = new Int32Array(n)
  for (let i = 0; i < n; i++) {
    const r = find(i)
    let c = id.get(r)
    if (c === undefined) {
      c = sums.length
      id.set(r, c)
      sums.push([0, 0, 0, 0])
    }
    of[i] = c
    const s = sums[c]
    s[0] += pos.getX(i)
    s[1] += pos.getY(i)
    s[2] += pos.getZ(i)
    s[3]++
  }
  return { of, centers: sums.map(([x, y, z, c]) => [x / c, y / c, z / c]) }
}

/** 0–1 的伪随机（与 shader 里的 hash 同一个式子） */
export function bubbleHash(x: number, y: number, z: number) {
  const h = Math.sin(x * 12.9898 + y * 78.233 + z * 37.719) * 43758.5453
  return h - Math.floor(h)
}

/** 每个泡泡一个随机相位（顶点属性 aEdenBubblePhase）：按泡泡中心算，同一个泡泡整体一起浮动 */
export function bakeBubblePhase(mesh: Mesh) {
  const geo = mesh.geometry as BufferGeometry
  if (geo.getAttribute('aEdenBubblePhase')) return
  const { of, centers } = bubbleComponents(geo)
  const phase = centers.map(([x, y, z]) => bubbleHash(x, y, z))
  const out = new Float32Array(of.length)
  for (let i = 0; i < of.length; i++) out[i] = phase[of[i]]
  geo.setAttribute('aEdenBubblePhase', new BufferAttribute(out, 1))
}
