import { Vector3 } from 'three'

// 角色与相机共享的可变状态（逐帧读写，不走 React 渲染）。
// yaw = 0 时角色朝 -Z。
export const rig = {
  position: new Vector3(),
  yaw: 0,
  pitch: 0.25,
  /** 发现资产时相机平滑转向它（FollowCamera 处理）：资产 id 与开始时刻（performance.now() 秒），id 为 null 表示没有在转 */
  focus: { id: null as string | null, start: 0 },
}

/** 各交互资产的世界中心（不含上下浮动），CollectableAsset 逐帧写入，相机对焦用 */
export const assetCenters = new Map<string, Vector3>()

export function forwardFromYaw(yaw: number, out = new Vector3()) {
  return out.set(-Math.sin(yaw), 0, -Math.cos(yaw))
}

export function rightFromYaw(yaw: number, out = new Vector3()) {
  return out.set(Math.cos(yaw), 0, -Math.sin(yaw))
}

/** 帧率无关的指数阻尼系数；timeConstant 单位秒 */
export const dampFactor = (timeConstant: number, dt: number) =>
  timeConstant <= 0 ? 1 : 1 - Math.exp(-dt / timeConstant)

// DEV：暴露给自动化测试脚本读取角色位置
if (import.meta.env.DEV) (window as unknown as { __rig: typeof rig }).__rig = rig
