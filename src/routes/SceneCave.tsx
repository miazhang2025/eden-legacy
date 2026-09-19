import { SceneShell } from '../scene/SceneShell'
import { SceneGuard } from './SceneGuard'

export default function SceneCave() {
  return (
    <SceneGuard scene="cave">
      <SceneShell sceneId="cave" />
    </SceneGuard>
  )
}
