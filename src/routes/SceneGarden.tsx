import { SceneShell } from '../scene/SceneShell'
import { SceneGuard } from './SceneGuard'

export default function SceneGarden() {
  return (
    <SceneGuard scene="garden">
      <SceneShell sceneId="garden" />
    </SceneGuard>
  )
}
