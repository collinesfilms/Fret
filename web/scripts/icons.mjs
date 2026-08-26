/**
 * Rasterises favicon.svg into the PNG sizes an installed app needs.
 *
 *   npm run icons
 *
 * Fret draws every mark in the interface itself, with no image assets
 * anywhere — but a home-screen icon is not part of the interface. It is an
 * artifact the operating system reads out of a file, and PNG is the only
 * format it is guaranteed to accept. So the SVG stays the source of truth and
 * these are generated from it, the same way the README's screenshots are
 * taken from the running application rather than mocked up.
 *
 * Re-run after any change to favicon.svg. Never hand-edit the PNGs.
 */

import { chromium } from 'playwright'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC = resolve(HERE, '../public')

/*
 * 192 and 512 are what a web manifest is expected to carry; 180 is what iOS
 * asks for by name. The maskable variants are the same drawing on a filled
 * ground, because a platform that crops to a circle would otherwise cut the
 * screen's corners off and leave the caret sitting on nothing.
 */
const SIZES = [
  { file: 'icon-192.png', size: 192 },
  { file: 'icon-512.png', size: 512 },
  { file: 'apple-touch-icon.png', size: 180, pad: 0.14, ground: '#17171a' },
]

const source = await readFile(resolve(PUBLIC, 'favicon.svg'), 'utf8')

const browser = await chromium.launch(
  process.env.FRET_CHROMIUM ? { executablePath: process.env.FRET_CHROMIUM } : {},
)

for (const { file, size, pad = 0, ground = 'transparent' } of SIZES) {
  const context = await browser.newContext({ viewport: { width: size, height: size } })
  const page = await context.newPage()
  const inset = Math.round(size * pad)
  await page.setContent(
    `<!doctype html><style>
       html,body{margin:0;padding:0;width:${size}px;height:${size}px;background:${ground}}
       svg{display:block;width:${size - inset * 2}px;height:${size - inset * 2}px;margin:${inset}px}
     </style>${source}`,
  )
  await page.waitForTimeout(60)
  const shot = await page.screenshot({ omitBackground: ground === 'transparent' })
  await writeFile(resolve(PUBLIC, file), shot)
  console.log(`  ${file} (${size}px)`)
  await context.close()
}

await browser.close()
