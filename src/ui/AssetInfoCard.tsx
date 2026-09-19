import { useEffect, useState } from 'react'
import { assetDesc, assetName, getAsset } from '../data/assets'
import { copy } from '../data/copy'
import { useFlowStore } from '../state/useFlowStore'

// pop up card：名称 + 一句简短描述 + 收集按钮
export function AssetInfoCard() {
  const phase = useFlowStore((s) => s.phase)
  const assetId = useFlowStore((s) => s.assetId)
  const visible = phase === 'INSPECTING'

  // 收起动画期间保留最后一个资产的内容，避免文字突然消失
  const [shownId, setShownId] = useState<string | null>(null)
  useEffect(() => {
    if (visible && assetId) setShownId(assetId)
  }, [visible, assetId])

  const asset = getAsset(shownId)
  return (
    <div className={`asset-card ${visible ? 'is-visible' : ''}`} aria-hidden={!visible}>
      {asset && (
        <>
          <h2 className="asset-card__name">{assetName(asset)}</h2>
          <p className="asset-card__desc">{assetDesc(asset)}</p>
          <button
            className="btn asset-card__collect"
            disabled={!visible}
            onClick={() => useFlowStore.getState().confirm(asset.id)}
          >
            {copy('card.button.collect')}
          </button>
        </>
      )}
    </div>
  )
}
