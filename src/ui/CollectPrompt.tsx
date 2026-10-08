import { useEffect, useState } from 'react'
import type { SceneId } from '../config/schema'
import { copy } from '../data/copy'
import { useSceneCfg } from '../state/useConfigStore'
import { useFlowStore } from '../state/useFlowStore'
import { useTransition } from './Transition'

// 场景 UI（spec §4 表格）拆成两块：
//   底部叙事提示：进场景（黑场淡开后）显示 introPromptSeconds 秒后消失；四个都找到后再出现，提示可以采集了
//   顶部发现进度：探索期间一直显示找到了几个
export function CollectPrompt({ sceneId }: { sceneId: SceneId }) {
  const phase = useFlowStore((s) => s.phase)
  const found = useFlowStore((s) => s.discovered.length)
  const total = useFlowStore((s) => s.total)
  const revealed = useTransition((s) => !s.covered)
  const introSeconds = useSceneCfg((c) => c.flow.introPromptSeconds)
  const [introOver, setIntroOver] = useState(false)

  // 计时从画面露出来开始（加载时黑场还盖着）
  useEffect(() => {
    setIntroOver(false)
    if (!revealed) return
    const t = window.setTimeout(() => setIntroOver(true), introSeconds * 1000)
    return () => clearTimeout(t)
  }, [sceneId, revealed, introSeconds])

  const active = revealed && (phase === 'EXPLORING' || phase === 'INSPECTING')
  const allFound = total > 0 && found >= total
  const showBubble = active && (allFound || !introOver)

  return (
    <>
      <div className={`collect-prompt ${showBubble ? 'is-visible' : ''}`} aria-hidden={!showBubble} aria-live="polite">
        {allFound ? copy('scene.progress.done') : copy(`scene.${sceneId}.prompt`)}
      </div>
      <div className={`discovery ${active && total > 0 ? 'is-visible' : ''} ${allFound ? 'is-done' : ''}`} aria-hidden={!active}>
        <span className="discovery__hearts" aria-hidden="true">
          {Array.from({ length: total }, (_, i) => (
            <i key={i} className={i < found ? 'is-found' : ''}>
              {i < found ? '♥' : '♡'}
            </i>
          ))}
        </span>
        <span className="discovery__text">
          {copy('scene.progress').replace('{found}', String(found)).replace('{total}', String(total))}
        </span>
      </div>
    </>
  )
}
