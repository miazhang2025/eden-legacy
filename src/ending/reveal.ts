// Ending 入场时间线（自己写，不用 Theatre 时间轴，见 ADR-003）
// 顺序：画布淡入（CSS）→ 标本盒放大 → 三件标本依次落位

let startedAt = -1

export function startReveal() {
  startedAt = performance.now() / 1000
}

export const revealElapsed = () => (startedAt < 0 ? 0 : performance.now() / 1000 - startedAt)

export const easeOutCubic = (t: number) => 1 - Math.pow(1 - Math.min(Math.max(t, 0), 1), 3)

/** 某一段（delay 后持续 duration）的进度 0–1 */
export function segment(delay: number, duration: number): number {
  if (startedAt < 0) return 0
  if (duration <= 0) return 1
  return easeOutCubic((revealElapsed() - delay) / duration)
}
