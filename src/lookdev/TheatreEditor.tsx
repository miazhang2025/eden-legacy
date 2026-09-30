// 仅 DEV：Theatre.js 摆位工具（spec §9.5）。
// 通过 lookdev/theatre.ts 的 lazy import 按需加载，生产构建里不存在（npm run check:bundle 校验）。
//
// 做法：每个可摆放的对象在 Theatre 里对应一个「只在编辑器视图可见」的代理物体。
// 拖动代理 → onValuesChange → 实时写回运行时 config / 资产覆盖，场景立即跟随。
// 「保存摆位」把 Theatre state 写到 theatre/<scene>.theatre-project-state.json，
// 再用 `npm run bake:theatre` 单向烘回 config/scenes/*.json。

import { useEffect, useState } from 'react'
import { useFrame } from '@react-three/fiber'
import { getProject, type ISheet, type ISheetObject } from '@theatre/core'
import studioModule from '@theatre/studio'
import extensionModule from '@theatre/r3f/dist/extension'
import { SheetProvider, editable as e } from '@theatre/r3f'
import type { ConfigId, SceneId, Vec3 } from '../config/schema'
import type { RoleName } from '../ending/composition'
import { groundHeightFromSky, hasCollider } from '../scene/collision'
import { useConfigStore } from '../state/useConfigStore'

// @theatre/studio 与 r3f extension 是 CJS 包，经 Vite 预构建后 default 可能多包一层
const unwrap = <T,>(m: T): T => ((m as { default?: T }).default ?? m)
const studio = unwrap(studioModule)
const extension = unwrap(extensionModule)

/** Theatre 里的 sheet 名，与 scripts/bake-theatre.ts 保持一致 */
const SHEET = 'layout'
const projectId = (id: ConfigId) => `eden-${id}`

// 本模块只在 Theatre 模式下被 lazy import，加载即初始化 studio（Theatre 要求 import 后立即初始化）
studio.initialize()
studio.extend(extension)

// 版本库里的 state 文件（中间产物）。有就从它接着拖。
const savedStates = import.meta.glob('/theatre/*.theatre-project-state.json', { eager: true, import: 'default' })

function useSheet(id: ConfigId): ISheet {
  const [sheet] = useState(() => {
    const state = savedStates[`/theatre/${id}.theatre-project-state.json`]
    return getProject(projectId(id), state ? { state } : undefined).sheet(SHEET)
  })
  return sheet
}

type Transform = { position: { x: number; y: number; z: number }; rotation: { x: number; y: number; z: number }; scale: { x: number; y: number; z: number } }
const v3 = (p: { x: number; y: number; z: number }, digits = 3): Vec3 => {
  const r = (n: number) => +n.toFixed(digits)
  return [r(p.x), r(p.y), r(p.z)]
}

// 自动化测试用：按 theatreKey 取到 sheet object 与 studio
const debug = ((window as unknown as { __theatre?: object }).__theatre = { studio, objects: {} as Record<string, ISheetObject> })

/** 订阅 sheet object 的数值变化 */
function useOnValues(obj: ISheetObject | null, cb: (v: Transform) => void) {
  useEffect(() => {
    if (!obj) return
    debug.objects[obj.address.objectKey] = obj
    return obj.onValuesChange((v) => cb(v as unknown as Transform))
    // cb 每次渲染都是新函数，但逻辑只依赖 obj
  }, [obj])
}

const PROXY_COLOR = '#ff4fd8'

function ZoneProxy() {
  const [init] = useState(() => {
    const f = useConfigStore.getState().configs[useConfigStore.getState().scene].flow
    const g = groundHeightFromSky(f.zoneCenter[0], f.zoneCenter[2]) ?? 0
    return { position: [f.zoneCenter[0], g, f.zoneCenter[2]] as Vec3, radius: f.zoneRadius }
  })
  const [obj, setObj] = useState<ISheetObject | null>(null)
  useOnValues(obj, (v) => {
    const scene = useConfigStore.getState().scene
    useConfigStore.getState().update(scene, (c) => {
      c.flow.zoneCenter = [+v.position.x.toFixed(3), 0, +v.position.z.toFixed(3)]
      c.flow.zoneRadius = +v.scale.x.toFixed(3)
    })
  })
  return (
    <e.group theatreKey="zone" visible="editor" objRef={setObj} position={init.position} scale={init.radius}>
      {/* 单位半径的圆环，半径 = scale.x */}
      <mesh rotation={[-Math.PI / 2, 0, 0]}>
        <torusGeometry args={[1, 0.02, 6, 64]} />
        <meshBasicMaterial color={PROXY_COLOR} />
      </mesh>
    </e.group>
  )
}

function SpawnProxy() {
  const [init] = useState(() => {
    const c = useConfigStore.getState().configs[useConfigStore.getState().scene].character
    const g = groundHeightFromSky(c.spawn[0], c.spawn[2]) ?? 0
    return { position: [c.spawn[0], g, c.spawn[2]] as Vec3, yaw: c.spawnYaw }
  })
  const [obj, setObj] = useState<ISheetObject | null>(null)
  useOnValues(obj, (v) => {
    const scene = useConfigStore.getState().scene
    useConfigStore.getState().update(scene, (c) => {
      c.character.spawn = [+v.position.x.toFixed(3), 0, +v.position.z.toFixed(3)]
      c.character.spawnYaw = +v.rotation.y.toFixed(4)
    })
  })
  return (
    <e.group theatreKey="spawn" visible="editor" objRef={setObj} position={init.position} rotation={[0, init.yaw, 0]}>
      {/* 箭头朝 -Z（yaw = 0 的朝向） */}
      <mesh position={[0, 0.9, -0.4]} rotation={[-Math.PI / 2, 0, 0]}>
        <coneGeometry args={[0.3, 0.8, 12]} />
        <meshBasicMaterial color={PROXY_COLOR} wireframe />
      </mesh>
    </e.group>
  )
}

function LightProxy({ theatreKey, position, onMove }: { theatreKey: string; position: Vec3; onMove: (p: Vec3) => void }) {
  const [init] = useState(position)
  const [obj, setObj] = useState<ISheetObject | null>(null)
  useOnValues(obj, (v) => onMove(v3(v.position)))
  return (
    <e.group theatreKey={theatreKey} visible="editor" objRef={setObj} position={init}>
      <mesh>
        <sphereGeometry args={[0.35, 12, 8]} />
        <meshBasicMaterial color="#ffd84f" wireframe />
      </mesh>
    </e.group>
  )
}

/** 探索场景的摆位编辑：zone（已弃用）、出生点、灯光。资产摆位改在 look dev 面板（config assets 段） */
export function TheatreSceneEditor({ sceneId }: { sceneId: SceneId }) {
  // 代理的初始高度依赖地面射线，等碰撞体注册后再挂载
  const [ready, setReady] = useState(hasCollider)
  useFrame(() => {
    if (!ready && hasCollider()) setReady(true)
  })
  return ready ? <SceneProxies sceneId={sceneId} /> : null
}

function SceneProxies({ sceneId }: { sceneId: SceneId }) {
  const sheet = useSheet(sceneId)
  const lights = useConfigStore((s) => s.configs[sceneId].lights)
  const update = useConfigStore((s) => s.update)


  return (
    <SheetProvider sheet={sheet}>
      <ZoneProxy />
      <SpawnProxy />
      <LightProxy
        theatreKey="light:directional"
        position={lights.directional.position}
        onMove={(p) => update(sceneId, (c) => void (c.lights.directional.position = p))}
      />
      {lights.points.map((l, i) => (
        <LightProxy
          key={l.name}
          theatreKey={`light:point:${l.name}`}
          position={l.position}
          onMove={(p) => update(sceneId, (c) => void (c.lights.points[i].position = p))}
        />
      ))}
    </SheetProvider>
  )
}

/** 构图角色的摆位代理：Theatre 里的位置 = anchor × 画框尺寸（不含镜像 / 扰动），线框盒 = region */
function RoleProxy({ role }: { role: RoleName }) {
  const [init] = useState(() => {
    const { composition, frame } = useConfigStore.getState().configs.ending
    return { r: composition[role], size: frame.size }
  })
  const [w, h, d] = init.size
  const [obj, setObj] = useState<ISheetObject | null>(null)
  useOnValues(obj, (v) => {
    useConfigStore.getState().update('ending', (c) => {
      const [fw, fh, fd] = c.frame.size
      const r = c.composition[role]
      r.anchor = v3({ x: v.position.x / fw, y: v.position.y / fh, z: v.position.z / fd }, 4)
      r.rotation = v3(v.rotation, 4)
      r.scale = +v.scale.x.toFixed(3)
    })
  })
  return (
    <e.group
      theatreKey={`role:${role}`}
      visible="editor"
      objRef={setObj}
      position={[init.r.anchor[0] * w, init.r.anchor[1] * h, init.r.anchor[2] * d]}
      rotation={init.r.rotation}
      scale={init.r.scale}
    >
      <mesh>
        <boxGeometry args={[init.r.region[0] * w, init.r.region[1] * h, init.r.region[2] * d]} />
        <meshBasicMaterial color={PROXY_COLOR} wireframe />
      </mesh>
    </e.group>
  )
}

/** Ending 的摆位编辑：主体 + 两件点缀 */
export function TheatreEndingEditor() {
  const sheet = useSheet('ending')
  return (
    <SheetProvider sheet={sheet}>
      <RoleProxy role="heroRole" />
      <RoleProxy role="accentNear" />
      <RoleProxy role="accentFar" />
    </SheetProvider>
  )
}

/** 保存按钮：把 Theatre state 写到 theatre/<id>.theatre-project-state.json（经 vite dev 中间件） */
export function TheatreSaveButton({ id }: { id: ConfigId }) {
  const [status, setStatus] = useState<string>('')
  const save = async () => {
    const state = studio.createContentOfSaveFile(projectId(id))
    const res = await fetch(`/__dev/theatre/${id}`, { method: 'POST', body: JSON.stringify(state, null, 2) })
    setStatus(res.ok ? `已保存 theatre/${id}.theatre-project-state.json，运行 npm run bake:theatre 写回 config` : '保存失败')
  }
  return (
    <div className="dev-layout-save">
      <button className="btn" onClick={save}>
        保存摆位
      </button>
      {status && <span>{status}</span>}
    </div>
  )
}
