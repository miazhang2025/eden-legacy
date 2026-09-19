import { SceneShell } from '../scene/SceneShell'
import { SceneGuard } from './SceneGuard'

export default function SceneOcean() {
  return (
    <SceneGuard scene="ocean">
      <SceneShell sceneId="ocean" />
    </SceneGuard>
  )
}
