import type { SceneId } from '../config/schema'
import { copy } from '../data/copy'
import { useFlowStore } from '../state/useFlowStore'

// 底部提示语（spec §4 表格）：探索时显示场景提示 + 发现进度
export function CollectPrompt({ sceneId }: { sceneId: SceneId }) {
  const phase = useFlowStore((s) => s.phase)
  const found = useFlowStore((s) => s.discovered.length)
  const total = useFlowStore((s) => s.total)
  const visible = phase === 'EXPLORING' || phase === 'INSPECTING'
  const progress =
    total > 0 && found >= total
      ? copy('scene.progress.done')
      : copy('scene.progress').replace('{found}', String(found)).replace('{total}', String(total))
  return (
    <div className={`collect-prompt ${visible ? 'is-visible' : ''}`} aria-hidden={!visible}>
      {copy(`scene.${sceneId}.prompt`)}
      <div className="collect-prompt__progress">{progress}</div>
    </div>
  )
}
