import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

export type Lang = 'zh' | 'en'

interface LangState {
  lang: Lang
  setLang(lang: Lang): void
}

const syncHtmlLang = (lang: Lang) => {
  document.documentElement.lang = lang === 'zh' ? 'zh-CN' : 'en'
}

/** 界面语言，默认英文。存 localStorage，下次打开沿用上次的选择。 */
export const useLangStore = create<LangState>()(
  persist(
    (set) => ({
      lang: 'en',
      setLang: (lang) => {
        syncHtmlLang(lang)
        set({ lang })
      },
    }),
    {
      name: 'ecobox.lang.v2',
      storage: createJSONStorage(() => localStorage),
      onRehydrateStorage: () => (s) => s && syncHtmlLang(s.lang),
    },
  ),
)
