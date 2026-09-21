import { assetDesc, assetName, getAsset } from '../data/assets'
import { useEndingUi } from './useEndingUi'

/** 悬停 / 点按标本时的名称与描述（spec §8.3） */
export function SpecimenTooltip() {
  const { hoveredId, x, y, dragging, exporting } = useEndingUi()
  const asset = getAsset(hoveredId)
  const visible = !!asset && !dragging && !exporting
  return (
    <div
      className={`specimen-tooltip ${visible ? 'is-visible' : ''}`}
      style={{ left: x, top: y }}
      aria-hidden={!visible}
    >
      {asset && (
        <>
          <strong>{assetName(asset)}</strong>
          <span>{assetDesc(asset)}</span>
        </>
      )}
    </div>
  )
}
