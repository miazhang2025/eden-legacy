import type { SceneId } from '../config/schema'
import { copy } from '../data/copy'
import { useFlowStore } from '../state/useFlowStore'

// 进入采集区后淡入的提示语（spec §4 表格）
export function CollectPrompt({ sceneId }: { sceneId: SceneId }) {
  const phase = useFlowStore((s) => s.phase)
  const visible = phase === 'PROMPTED' || phase === 'INSPECTING'
  return (
    <div className={`collect-prompt ${visible ? 'is-visible' : ''}`} aria-hidden={!visible}>
      {copy(`scene.${sceneId}.prompt`)}
    </div>
  )
}
