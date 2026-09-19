// 音频总线：ambience / sfx / master。素材未到位，当前所有调用都是静音占位（只打 console.debug），
// 但调用点已经埋好。素材到位后往 public/audio/ 放文件并填映射表即可。

import type { SceneId } from '../config/schema'

export type SfxName = 'zoneEnter' | 'assetNear' | 'collect' | 'boxReveal' | 'photoExport'

let ctx: AudioContext | null = null

export const AudioBus = {
  /** 必须在用户手势内调用（Landing 的进入按钮），解除浏览器自动播放限制 */
  resume() {
    try {
      ctx ??= new AudioContext()
      void ctx.resume()
    } catch {
      /* 不支持 WebAudio 时静默 */
    }
  },
  playAmbience(scene: SceneId | 'ending' | null) {
    console.debug('[audio] ambience', scene)
  },
  stopAmbience() {
    console.debug('[audio] ambience stop')
  },
  playSfx(name: SfxName) {
    console.debug('[audio] sfx', name)
  },
}
