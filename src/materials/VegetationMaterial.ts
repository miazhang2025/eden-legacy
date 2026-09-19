import { BufferAttribute, Box3, Vector3, type BufferGeometry, type Material, type Mesh } from 'three'
import type { SSSConfig, WindConfig } from '../config/schema'
import { createCSM, type EdenCSM } from './csm'
import { shared } from './uniforms'
import noise from './chunks/noise.glsl?raw'
import wind from './chunks/wind.glsl?raw'
import fakeSSS from './chunks/fakeSSS.glsl?raw'

// 风动植被 + 假 SSS（spec §5.2A / §5.2B）。ocean 的珊瑚水草复用同一材质，只改风参数。

/** 也用于阴影深度材质，保证阴影跟着摆 */
export const vegetationVertexShader = /* glsl */ `
  ${noise}
  ${wind}
  attribute float aEdenSoftness;
  attribute float aEdenThickness;
  varying vec3 vEdenWorldPos;
  varying vec3 vEdenWorldNormal;
  varying float vEdenThickness;

  void main() {
    mat4 model = modelMatrix;
    #ifdef USE_INSTANCING
      model = modelMatrix * instanceMatrix;
    #endif
    vec4 wp = model * vec4(position, 1.0);
    vec3 offset = edenWindOffset(wp.xyz, aEdenSoftness);
    mat3 m3 = mat3(model);
    csm_Position = position + inverse(m3) * offset;
    vEdenWorldPos = wp.xyz + offset;
    vEdenWorldNormal = normalize(m3 * normal);
    vEdenThickness = aEdenThickness;
  }
`

const fragmentShader = /* glsl */ `
  ${fakeSSS}
  varying vec3 vEdenWorldPos;
  varying vec3 vEdenWorldNormal;
  varying float vEdenThickness;

  void main() {
    // 叶片双面：背面朝向时翻转法线
    vec3 N = normalize(vEdenWorldNormal) * (gl_FrontFacing ? 1.0 : -1.0);
    csm_Emissive += edenSSS(vEdenWorldPos, N, vEdenThickness);
  }
`

export function createVegetationMaterial(source: Material): EdenCSM {
  const m = createCSM('standard', source, {
    vertexShader: vegetationVertexShader,
    fragmentShader,
    uniforms: shared,
    cacheKey: 'eden-vegetation-v1',
  })
  m.__edenRole = 'vegetation'
  return m
}

const tmp = new Vector3()
const box = new Box3()

/**
 * 给植被几何烘两个顶点属性（一次性 CPU 开销）：
 *   aEdenSoftness：风柔软度。顶点色 R（约定 R = 柔软度），没有顶点色或选择 localY 时按「世界高度在本 mesh 内归一化」回落，根部 0、顶端 1。
 *   aEdenThickness：SSS 厚度。顶点色 G，或常数 1。
 * 模型没刷顶点色时全部回落，不报错（spec §5.2B 约定 R = 柔软度，G = 厚度，B = 备用）。
 */
export function bakeVegetationAttributes(
  mesh: Mesh,
  stiffnessSource: WindConfig['stiffnessSource'],
  thicknessSource: SSSConfig['thicknessSource'],
) {
  const geo = mesh.geometry as BufferGeometry
  const pos = geo.getAttribute('position')
  const col = geo.getAttribute('color')
  const n = pos.count
  const soft = new Float32Array(n)
  const thick = new Float32Array(n).fill(1)

  if (stiffnessSource === 'vertexColor' && col) {
    for (let i = 0; i < n; i++) soft[i] = col.getX(i)
  } else {
    mesh.updateWorldMatrix(true, false)
    box.makeEmpty()
    const ys = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      tmp.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld)
      ys[i] = tmp.y
      box.expandByPoint(tmp)
    }
    const h = Math.max(box.max.y - box.min.y, 1e-4)
    for (let i = 0; i < n; i++) soft[i] = (ys[i] - box.min.y) / h
  }
  if (thicknessSource === 'vertexColor' && col) for (let i = 0; i < n; i++) thick[i] = col.getY(i)

  geo.setAttribute('aEdenSoftness', new BufferAttribute(soft, 1))
  geo.setAttribute('aEdenThickness', new BufferAttribute(thick, 1))
}
