import { useEffect, useState } from 'react'
import { assetDesc, assetName, assetSubname, getAsset } from '../data/assets'
import { copy } from '../data/copy'
import { useFlowStore } from '../state/useFlowStore'
import { Win } from './Win'

// pop up card：名称 + 一句简短描述 + 收集按钮（四个都看过才可收集）
export function AssetInfoCard() {
  const phase = useFlowStore((s) => s.phase)
  const assetId = useFlowStore((s) => s.assetId)
  const visible = phase === 'INSPECTING'
  const remaining = useFlowStore((s) => s.total - s.discovered.length)

  // 收起动画期间保留最后一个资产的内容，避免文字突然消失
  const [shownId, setShownId] = useState<string | null>(null)
  useEffect(() => {
    if (visible && assetId) setShownId(assetId)
  }, [visible, assetId])

  const asset = getAsset(shownId)
  return (
    <Win
      className={`asset-card ${visible ? 'is-visible' : ''}`}
      title={copy('card.title')}
      aria-hidden={!visible}
    >
      {asset && (
        <>
          <h2 className="asset-card__name">
            {assetName(asset)}
            {assetSubname(asset) && <small>{assetSubname(asset)}</small>}
          </h2>
          <p className="asset-card__desc">{assetDesc(asset)}</p>
          <button
            className="btn asset-card__collect"
            disabled={!visible || remaining > 0}
            onClick={() => useFlowStore.getState().confirm(asset.id)}
          >
            {remaining > 0 ? copy('card.button.locked').replace('{n}', String(remaining)) : copy('card.button.collect')}
          </button>
        </>
      )}
    </Win>
  )
}
