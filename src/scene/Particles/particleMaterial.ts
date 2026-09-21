import { AdditiveBlending, Color, NormalBlending, ShaderMaterial, Vector2, Vector3, type Texture } from 'three'
import { shared } from '../../materials/uniforms'
import noise from '../../materials/chunks/noise.glsl?raw'

// 无状态粒子（spec §5.3A）：每个粒子的 seed / phase / emitter 作为 instanced attribute 只写一次，
// 位置完全由 uTime 解析求出。每帧 CPU 开销只有推 uniform，没有回读、没有 RT、没有 GC。

export const MAX_EMITTERS = 16

export const SHAPES = { point: 0, box: 1, sphere: 2, cone: 3, disk: 4 } as const
export const APPEARANCES = { gradient: 0, circular: 1, square: 2 } as const
export const EASINGS = { linear: 0, easeIn: 1, easeOut: 2 } as const

export function createParticleUniforms() {
  return {
    uTime: shared.uTime,
    uEmitterPos: { value: Array.from({ length: MAX_EMITTERS }, () => new Vector3()) },
    uEmitterIntensity: { value: new Array<number>(MAX_EMITTERS).fill(1) },
    uEmitterGround: { value: new Array<number>(MAX_EMITTERS).fill(-1e4) },
    uEmitterDelay: { value: new Array<number>(MAX_EMITTERS).fill(0) },
    uLifetime: { value: new Vector2(1, 2) },
    uSpeed: { value: new Vector2(0, 1) },
    uDir: { value: new Vector3(0, 1, 0) },
    uSpread: { value: 0.5 },
    uGravity: { value: new Vector3() },
    uFriction: { value: 0 },
    uFrictionEase: { value: 0 },
    uTurb: { value: new Vector3() },
    uSize: { value: new Vector2(0.05, 0.1) },
    uColorStart: { value: new Color() },
    uColorEnd: { value: new Color() },
    uIntensity: { value: 1 },
    uShape: { value: 1 },
    uRadius: { value: 1 },
    uBoxSize: { value: new Vector3(1, 1, 1) },
    uAngle: { value: 0.3 },
    uHeight: { value: 0 },
    uSurfaceOnly: { value: 0 },
    uStartPosAsDir: { value: 0 },
    uRotation: { value: new Vector2() },
    uRotSpeed: { value: new Vector2() },
    uSoftDistance: { value: 0.5 },
    uGroundFade: { value: 0 },
    uFollowCamera: { value: 0 },
    uCurves: { value: null as Texture | null },
    uAppearance: { value: 0 },
    /** burst 模式：> 0.5 时粒子只播放一次，从 uBurstStart 开始（spec §5.3B） */
    uBurst: { value: 0 },
    uBurstStart: { value: -1e9 },
  }
}
export type ParticleUniforms = ReturnType<typeof createParticleUniforms>

const vertexShader = /* glsl */ `
  #define MAX_EMITTERS ${MAX_EMITTERS}
  uniform float uTime;
  uniform vec3 uEmitterPos[MAX_EMITTERS];
  uniform float uEmitterIntensity[MAX_EMITTERS];
  uniform float uEmitterGround[MAX_EMITTERS];
  uniform float uEmitterDelay[MAX_EMITTERS];
  uniform vec2 uLifetime;
  uniform vec2 uSpeed;
  uniform vec3 uDir;
  uniform float uSpread;
  uniform vec3 uGravity;
  uniform float uFriction;
  uniform float uFrictionEase;
  uniform vec3 uTurb;
  uniform vec2 uSize;
  uniform vec3 uColorStart;
  uniform vec3 uColorEnd;
  uniform float uShape;
  uniform float uRadius;
  uniform vec3 uBoxSize;
  uniform float uAngle;
  uniform float uHeight;
  uniform float uSurfaceOnly;
  uniform float uStartPosAsDir;
  uniform vec2 uRotation;
  uniform vec2 uRotSpeed;
  uniform float uSoftDistance;
  uniform float uGroundFade;
  uniform float uFollowCamera;
  uniform sampler2D uCurves;
  uniform float uBurst;
  uniform float uBurstStart;

  attribute vec4 aSeed;
  attribute float aEmitter;
  attribute float aPhase;

  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vColor;

  ${noise}

  float rnd(float s) { return fract(sin(s * 12.9898) * 43758.5453); }
  vec3 rnd3(float s) { return vec3(rnd(s), rnd(s + 1.71), rnd(s + 3.13)); }

  void main() {
    int ei = int(aEmitter + 0.5);
    float life = mix(uLifetime.x, uLifetime.y, aSeed.x);
    float t;
    float cycle = 0.0;
    bool dead = false;
    if (uBurst > 0.5) {
      t = uTime - uBurstStart - uEmitterDelay[ei] - aPhase * 0.25;
      dead = t < 0.0 || t > life;
    } else {
      float tt = uTime - uEmitterDelay[ei] + aPhase * life;
      dead = tt < 0.0;
      cycle = floor(tt / life);
      t = tt - cycle * life;
    }
    float p = clamp(t / life, 0.0, 1.0);
    // 每个生命周期重新随机出生点 / 方向
    float s = aSeed.w * 97.13 + cycle * 13.37;
    vec3 r = rnd3(s);

    // 出生点形状：point / box / sphere / cone / disk
    vec3 off = vec3(0.0);
    if (uShape > 0.5 && uShape < 1.5) {
      off = (r - 0.5) * uBoxSize;
    } else if (uShape > 1.5 && uShape < 2.5) {
      vec3 d = normalize(rnd3(s + 5.0) * 2.0 - 1.0 + 1e-4);
      off = d * uRadius * (uSurfaceOnly > 0.5 ? 1.0 : pow(r.x, 1.0 / 3.0));
    } else if (uShape > 2.5) {
      float a = r.x * 6.2831853;
      float rad = uRadius * (uSurfaceOnly > 0.5 ? 1.0 : sqrt(r.y));
      off = vec3(cos(a) * rad, uShape < 3.5 ? r.z * uHeight : 0.0, sin(a) * rad);
    }
    vec3 origin = uEmitterPos[ei] + off;

    // 速度方向（cone 用 emitterAngle 作扩散，其它用 directionSpread）
    vec3 dir = uStartPosAsDir > 0.5 && length(off) > 1e-4 ? normalize(off) : normalize(uDir + 1e-5);
    float spread = uShape > 2.5 && uShape < 3.5 ? uAngle : uSpread;
    dir = normalize(dir + (rnd3(s + 9.0) * 2.0 - 1.0) * spread);
    float speed = mix(uSpeed.x, uSpeed.y, r.z);

    vec4 curve = texture2D(uCurves, vec2(p, 0.5));
    float travel = speed * life * curve.a;
    float ease = uFrictionEase < 0.5 ? p : (uFrictionEase < 1.5 ? p * p : 1.0 - (1.0 - p) * (1.0 - p));
    travel *= 1.0 - uFriction * ease * 0.5;
    vec3 pos = origin + dir * travel + 0.5 * uGravity * t * t;

    // 湍流
    if (uTurb.x > 0.0) {
      vec2 q = origin.xz * uTurb.y + uTime * uTurb.z;
      pos += (vec3(edenNoise(q), edenNoise(q + 17.3), edenNoise(q + 41.7)) - 0.5) * 2.0 * uTurb.x;
    }

    // 跟随相机：在以相机为中心的盒子里循环（环境浮尘始终围绕玩家）
    if (uFollowCamera > 0.5) {
      pos = cameraPosition + mod(pos - cameraPosition + uBoxSize * 0.5, uBoxSize) - uBoxSize * 0.5;
    }

    float size = mix(uSize.x, uSize.y, aSeed.y) * curve.r;
    float alpha = curve.g * uEmitterIntensity[ei];
    // 降级 soft particles（spec §5.3E）：近相机淡出 + 贴地淡出，零额外 pass
    float camDist = distance(pos, cameraPosition);
    if (uSoftDistance > 0.0) alpha *= smoothstep(0.0, uSoftDistance, camDist - size);
    if (uGroundFade > 0.0) alpha *= smoothstep(0.0, uGroundFade, pos.y - uEmitterGround[ei]);

    if (dead || alpha <= 0.001 || size <= 0.0) {
      gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
      vAlpha = 0.0;
      vUv = vec2(0.0);
      vColor = vec3(0.0);
      return;
    }

    float rot = mix(uRotation.x, uRotation.y, r.x) + mix(uRotSpeed.x, uRotSpeed.y, r.y) * t;
    float cs = cos(rot);
    float sn = sin(rot);
    vec2 corner = mat2(cs, sn, -sn, cs) * position.xy * size;
    vec4 mv = viewMatrix * vec4(pos, 1.0);
    mv.xy += corner;
    gl_Position = projectionMatrix * mv;

    vUv = position.xy + 0.5;
    vAlpha = alpha;
    vColor = mix(uColorStart, uColorEnd, p);
  }
`

const fragmentShader = /* glsl */ `
  uniform float uIntensity;
  uniform float uAppearance;
  varying vec2 vUv;
  varying float vAlpha;
  varying vec3 vColor;
  void main() {
    float d = length(vUv - 0.5) * 2.0;
    float a = 1.0;
    if (uAppearance < 0.5) a = pow(clamp(1.0 - d, 0.0, 1.0), 1.6);
    else if (uAppearance < 1.5) a = 1.0 - smoothstep(0.85, 1.0, d);
    a *= vAlpha;
    if (a < 0.002) discard;
    gl_FragColor = vec4(vColor * uIntensity, a);
  }
`

export function createParticleMaterial(uniforms: ParticleUniforms, additive: boolean, depthTest: boolean) {
  return new ShaderMaterial({
    uniforms,
    vertexShader,
    fragmentShader,
    transparent: true,
    depthWrite: false,
    depthTest,
    blending: additive ? AdditiveBlending : NormalBlending,
  })
}
