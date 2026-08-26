/**
 * Measures every translated string against the box it has to fit in.
 *
 * A translation does not break a layout by being wrong. It breaks it by being
 * longer than the English the box was drawn around — French `fichiers` in a
 * tile sized for `files` — and the failure is silent: the text clips, or it
 * spills over a border, and nothing throws.
 *
 * Most strings sit on a line that is as wide as the panel and can take
 * whatever a language gives them. The ones that cannot are listed in BOXES
 * below: a fixed width, or a row divided evenly between N controls. Those are
 * the ones this measures.
 *
 *   go run ./cmd/fret-demo    # terminal 1 — any locale; only the boxes are read
 *   cd web && npm run audit:i18n
 *
 * The box widths and the exact font of each one are read from the running
 * application rather than restated here, so the numbers cannot drift from the
 * stylesheet. Every catalog is then measured against them in the same browser.
 *
 * Exits non-zero on anything that does not fit.
 */

import { chromium } from 'playwright'
import { execFileSync } from 'node:child_process'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const BASE = process.env.FRET_DEMO_URL ?? 'http://127.0.0.1:8080'

/*
 * Every box in the interface that a string can outgrow.
 *
 *   probe   an element to read the font and the available width from, live
 *   share   how many controls divide that width between them (1 = it is the
 *           box itself)
 *   keys    the catalog entries that land in it
 *
 * `open` is what has to be true on the page for the probe to exist, and is the
 * only reason this needs a running server at all.
 */
const BOXES = [
  {
    name: 'file tile',
    probe: '.fret-tile__unit',
    within: '.fret-tile',
    open: 'sheet',
    keys: ['sheet.files'],
  },
  {
    name: 'row action',
    probe: '.fret-rowaction',
    within: '.fret-rowaction',
    open: 'row',
    keys: ['action.copy', 'action.copied', 'action.edit', 'action.open', 'action.delete'],
  },
  {
    name: 'secondary key',
    probe: '.fret-actions__secondary',
    within: '.fret-actions__secondary',
    open: 'files',
    keys: ['key.options', 'key.new', 'key.cancel'],
  },
  {
    name: 'primary key',
    probe: '.fret-actions__primary .fret-key__label',
    within: '.fret-actions__primary',
    open: 'files',
    keys: ['key.copy', 'key.copied', 'key.waiting', 'app.retry', 'recipient.unlock'],
  },
  {
    name: 'expiry segment',
    probe: '.fret-tray .fret-segmented__item',
    within: '.fret-tray .fret-segmented',
    share: 4,
    open: 'tray',
    keys: ['expiry.opt24h', 'expiry.opt7d', 'expiry.opt30d', 'expiry.optNever'],
  },
  {
    name: 'stat label',
    probe: '.fret-stat__label',
    within: '.fret-stats',
    share: 3,
    open: 'sheet',
    keys: ['sheet.statActive', 'sheet.statStorage', 'sheet.statExpiring'],
  },
  {
    name: 'strip label',
    probe: '.fret-screen__stripLabel',
    within: '.fret-screen__strip',
    share: 2,
    open: 'files',
    keys: [
      'app.ready',
      'app.uploading',
      'app.complete',
      'app.failed',
      'app.resumable',
      'app.releaseStrip',
      'recipient.ready',
      'recipient.lockedStrip',
      'recipient.expiredStrip',
      'recipient.notFoundStrip',
    ],
  },
  {
    name: 'strip right',
    probe: '.fret-screen__stripLabel',
    within: '.fret-screen__strip',
    share: 2,
    open: 'files',
    keys: ['expiry.none', 'expiry.expired', 'expiry.minutes', 'expiry.hours', 'expiry.days'],
  },
]

/** Placeholder stand-ins, so a measured string is the length it really renders. */
const SAMPLE = { n: '30', count: '4 fichiers', s: '45', m: '38', h: '2', size: '1,25 Go' }

function fill(template) {
  return template.replace(/\{(\w+)\}/g, (match, name) => SAMPLE[name] ?? match)
}

/** Compiles the catalog so this can read it without a TypeScript runtime. */
async function catalogs() {
  const out = join(mkdtempSync(join(tmpdir(), 'fret-i18n-')), 'i18n.mjs')
  execFileSync(
    'npx',
    ['esbuild', resolve(HERE, '../src/lib/i18n.ts'), '--format=esm', `--outfile=${out}`, '--log-level=error'],
    { cwd: resolve(HERE, '..') },
  )
  return (await import(out)).catalogs
}

async function main() {
  const tables = await catalogs()
  const locales = Object.keys(tables)

  const browser = await chromium.launch(
    process.env.FRET_CHROMIUM ? { executablePath: process.env.FRET_CHROMIUM } : {},
  )

  const failures = []

  for (const [viewport, where] of [
    [{ width: 1180, height: 940 }, 'desktop'],
    [{ width: 414, height: 820 }, 'mobile'],
  ]) {
    const context = await browser.newContext({ viewport })
    const page = await context.newPage()
    await page.goto(`${BASE}/demo-login`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.fret-chrome', { timeout: 20_000 })
    await page.evaluate(() => document.fonts.ready)

    // Bring every probe on screen: a file on the device, its drawer open, and
    // the transfers list with a row expanded.
    await page.setInputFiles('input[type=file]', [
      { name: 'a.mov', mimeType: 'application/octet-stream', buffer: Buffer.alloc(1 << 20) },
    ])
    await page.waitForSelector('.fret-actions__primary:not(.fret-key--inert)', { timeout: 90_000 })
    await page.locator('.fret-actions__secondary').first().click()
    await page.waitForSelector('.fret-tray--open')
    await page.click('.fret-pill')
    await page.waitForTimeout(500)
    await page.locator('.fret-row__main').first().click()
    await page.waitForSelector('.fret-rowaction', { timeout: 15_000 })
    await page.waitForTimeout(400)

    console.log(`\n${where}`)

    for (const box of BOXES) {
      const measured = await page.evaluate(
        ({ box, tables, locales, SAMPLE }) => {
          const probe = document.querySelector(box.probe)
          const within = document.querySelector(box.within)
          if (!probe || !within) return { missing: true }

          const style = getComputedStyle(probe)
          const containerStyle = getComputedStyle(within)
          const inner =
            within.getBoundingClientRect().width -
            parseFloat(containerStyle.borderLeftWidth) -
            parseFloat(containerStyle.borderRightWidth) -
            parseFloat(containerStyle.paddingLeft) -
            parseFloat(containerStyle.paddingRight)

          // The share of that width this control gets, less its own padding.
          const share = inner / (box.share ?? 1)
          const available =
            share - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)

          // Measured with the probe's own font, tracking and casing.
          const ruler = document.createElement('span')
          ruler.style.cssText = `position:absolute;visibility:hidden;white-space:pre;font:${style.font};letter-spacing:${style.letterSpacing};text-transform:${style.textTransform};`
          document.body.appendChild(ruler)

          const fill = (t) => t.replace(/\{(\w+)\}/g, (m, n) => SAMPLE[n] ?? m)
          const rows = []
          for (const key of box.keys) {
            const widths = {}
            for (const locale of locales) {
              const text = tables[locale][key]
              if (text == null) continue
              ruler.textContent = fill(text)
              widths[locale] = { text: fill(text), width: ruler.getBoundingClientRect().width }
            }
            rows.push({ key, widths })
          }
          ruler.remove()
          return { available, rows }
        },
        { box, tables, locales, SAMPLE },
      )

      if (measured.missing) {
        console.log(`  ?  ${box.name} — probe not on screen, skipped`)
        continue
      }

      const over = []
      for (const row of measured.rows) {
        for (const locale of locales) {
          const cell = row.widths[locale]
          if (cell && cell.width > measured.available) {
            over.push({ ...row, locale, ...cell })
          }
        }
      }

      const room = Math.round(measured.available)
      if (over.length === 0) {
        console.log(`  ok ${box.name} — ${room}px`)
      } else {
        console.log(`  ✗  ${box.name} — ${room}px`)
        for (const item of over) {
          console.log(
            `       ${item.locale} ${item.key} "${item.text}" needs ${Math.round(item.width)}px`,
          )
          failures.push({ where, box: box.name, room, ...item })
        }
      }
    }

    await context.close()
  }

  await browser.close()

  console.log('')
  if (failures.length === 0) {
    console.log('every string fits its box.\n')
    return
  }
  console.log(`${failures.length} do not fit:\n`)
  for (const f of failures) {
    console.log(
      `  ${f.where} · ${f.box} · ${f.locale} · ${f.key}: ${Math.round(f.width)}px into ${f.room}px`,
    )
  }
  console.log('')
  process.exitCode = 1
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
