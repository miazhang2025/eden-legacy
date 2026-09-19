import { Vector3 } from 'three'

// 角色与相机共享的可变状态（逐帧读写，不走 React 渲染）。
// yaw = 0 时角色朝 -Z。
export const rig = {
  position: new Vector3(),
  yaw: 0,
  pitch: 0.25,
}

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
