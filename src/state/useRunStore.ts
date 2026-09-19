import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'
import type { SceneId } from '../config/schema'

export const SCENE_ORDER: SceneId[] = ['cave', 'ocean', 'garden']

export const sceneRoute = (s: SceneId) => `/${s}`

interface RunState {
  selections: Record<SceneId, string | null>
  order: SceneId[]
  select(scene: SceneId, assetId: string): void
  reset(): void
  isComplete(): boolean
  /** 第一个未完成场景；全部完成时为 null */
  firstIncomplete(): SceneId | null
  nextRoute(): string
}

const empty = (): Record<SceneId, string | null> => ({ cave: null, ocean: null, garden: null })

export const useRunStore = create<RunState>()(
  persist(
    (set, get) => ({
      selections: empty(),
      order: SCENE_ORDER,
      select: (scene, assetId) => set((s) => ({ selections: { ...s.selections, [scene]: assetId } })),
      reset: () => set({ selections: empty() }),
      isComplete: () => get().firstIncomplete() === null,
      firstIncomplete: () => SCENE_ORDER.find((s) => !get().selections[s]) ?? null,
      nextRoute: () => {
        const s = get().firstIncomplete()
        return s ? sceneRoute(s) : '/ending'
      },
    }),
    {
      name: 'ecobox.run.v1',
      storage: createJSONStorage(() => sessionStorage),
      partialize: (s) => ({ selections: s.selections }),
    },
  ),
)
