// 地面平铺贴图（Megascans surface）→ 运行时用的 KTX2
//   art/textures/ground/<id>_4K_{Albedo,Normal,Roughness,AO}.jpg
//     ──► public/textures/ground/<id>_albedo.ktx2   ETC1S（sRGB）
//         public/textures/ground/<id>_normal.ktx2   UASTC + zstd（法线用 ETC1S 会出块）
//         public/textures/ground/<id>_orm.ktx2      ETC1S（线性）：R = AO，G = 粗糙度
//   全部带 mipmap，GPU 端保持压缩格式。Displacement 不用（地形网格没那么密）。
//
// 用法：npm run ground            处理 SETS 里的全部
//       npm run ground -- pjvxx   只处理一套

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'
import sharp from 'sharp'

/** 要处理的贴图套（Megascans id）与输出边长（法线为一半） */
const SETS = { pjvxx: 1024, pftoh: 1024 }

const SRC = 'art/textures/ground'
const OUT = 'public/textures/ground'
const TMP = join(OUT, '.tmp')

const KTX_BIN = process.env.KTX_BIN ?? join(process.env.USERPROFILE ?? process.env.HOME ?? '', 'tools', 'KTX', 'bin')
const KTX = join(KTX_BIN, process.platform === 'win32' ? 'ktx.exe' : 'ktx')
if (!existsSync(KTX)) {
  console.error(`没找到 KTX-Software：${KTX}（可用环境变量 KTX_BIN 指定 bin 目录）`)
  process.exit(1)
}

const ktx = (args) => execFileSync(KTX, ['create', ...args], { stdio: 'pipe' })
const kb = (f) => `${Math.round(statSync(f).size / 1024)}KB`

mkdirSync(TMP, { recursive: true })
const only = process.argv[2]
for (const [id, size] of Object.entries(SETS)) {
  if (only && id !== only) continue
  const src = (kind) => join(SRC, `${id}_4K_${kind}.jpg`)
  const tmp = (kind) => join(TMP, `${id}_${kind}.png`)
  const out = (kind) => join(OUT, `${id}_${kind}.ktx2`)
  console.log(`\n▸ ${id}（${size}px）`)

  // 缩小用 lanczos，平铺贴图边缘保持无缝
  await sharp(src('Albedo')).resize(size, size, { kernel: 'lanczos3' }).removeAlpha().png().toFile(tmp('albedo'))
  // 法线减半：1m 平铺上 512 已经是 2mm/像素，UASTC 体积是 ETC1S 的好几倍
  await sharp(src('Normal')).resize(size / 2, size / 2, { kernel: 'lanczos3' }).removeAlpha().png().toFile(tmp('normal'))
  // ORM：R = AO，G = 粗糙度，B 空着
  const ao = await sharp(src('AO')).resize(size, size, { kernel: 'lanczos3' }).greyscale().raw().toBuffer()
  const rough = await sharp(src('Roughness')).resize(size, size, { kernel: 'lanczos3' }).greyscale().raw().toBuffer()
  const orm = Buffer.alloc(size * size * 3)
  for (let i = 0; i < size * size; i++) {
    orm[i * 3] = ao[i]
    orm[i * 3 + 1] = rough[i]
  }
  await sharp(orm, { raw: { width: size, height: size, channels: 3 } }).png().toFile(tmp('orm'))

  const etc1s = ['--encode', 'basis-lz', '--qlevel', '200', '--generate-mipmap']
  ktx(['--format', 'R8G8B8_SRGB', ...etc1s, tmp('albedo'), out('albedo')])
  ktx(['--format', 'R8G8B8_UNORM', '--assign-tf', 'linear', ...etc1s, tmp('orm'), out('orm')])
  ktx([
    '--format', 'R8G8B8_UNORM', '--assign-tf', 'linear',
    '--encode', 'uastc', '--uastc-quality', '2', '--zstd', '18', '--normal-mode', '--generate-mipmap',
    tmp('normal'), out('normal'),
  ])
  console.log(`  albedo ${kb(out('albedo'))} · normal ${kb(out('normal'))} · orm ${kb(out('orm'))}`)
}
rmSync(TMP, { recursive: true, force: true })
