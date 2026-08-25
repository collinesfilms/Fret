/**
 * Captures the screenshots used in the README.
 *
 * Start the demo server first, then run this:
 *
 *   go run ./cmd/fret-demo
 *   cd web && npm run screenshots
 *
 * Every image comes from the real application driven through a real browser —
 * nothing here is a mockup, so re-running it after a design change refreshes
 * the lot.
 */

import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = resolve(HERE, '../../docs/screenshots')
const BASE = process.env.FRET_DEMO_URL ?? 'http://127.0.0.1:8080'

/*
 * Viewports are sized per shot so the device fills its frame. The panel is
 * 568px wide, so a wide window would leave most of the image empty; the sheet
 * needs the extra width because it sits beside the device.
 */
const DEVICE = { width: 900, height: 660 }
const DEVICE_TALL = { width: 900, height: 900 }
const CARD = { width: 720, height: 560 }
const WIDE = { width: 1240, height: 840 }
const MOBILE = { width: 414, height: 820 }

let browser

/**
 * Waits for the page to be worth photographing: fonts loaded, and the blinking
 * caret pinned on so a shot cannot land in the half of the cycle where it is
 * invisible.
 */
async function settle(page, ms = 500) {
  await page.addStyleTag({
    content: '.fret-caret { animation: none !important; opacity: 1 !important; }',
  })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(ms)
}

async function shot(page, name) {
  await settle(page)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log(`  ${name}.png`)
}

/**
 * Screenshots a region framed around the app's own content.
 *
 * The device is a fixed 568px wide and vertically centred in the viewport, so
 * a plain full-page shot leaves most of the image empty. This measures what is
 * actually on screen and clips to it with an even margin.
 */
async function shotFramed(page, name, selectors, pad = 44) {
  await settle(page)
  const box = await page.evaluate((list) => {
    const rects = list
      .map((selector) => document.querySelector(selector))
      .filter(Boolean)
      .map((element) => element.getBoundingClientRect())
    if (rects.length === 0) return null
    return {
      left: Math.min(...rects.map((r) => r.left)),
      top: Math.min(...rects.map((r) => r.top)),
      right: Math.max(...rects.map((r) => r.right)),
      bottom: Math.max(...rects.map((r) => r.bottom)),
      width: window.innerWidth,
      height: window.innerHeight,
    }
  }, selectors)

  if (!box) return shot(page, name)

  const x = Math.max(0, Math.floor(box.left - pad))
  const y = Math.max(0, Math.floor(box.top - pad))
  const clip = {
    x,
    y,
    width: Math.min(box.width - x, Math.ceil(box.right - x + pad)),
    height: Math.min(box.height - y, Math.ceil(box.bottom - y + pad)),
  }
  await page.screenshot({ path: `${OUT}/${name}.png`, clip })
  console.log(`  ${name}.png`)
}

/** The app chrome plus the device, which is the frame most shots want. */
const APP = ['.fret-chrome', '.fret-panel']

/**
 * Shrinks the viewport to the height its content actually needs.
 *
 * The device is vertically centred in the window, so a tall viewport pushes it
 * into the middle of a large empty field. Fitting first means the clip that
 * follows has almost nothing to trim.
 */
async function fitViewport(page, selectors, pad = 40) {
  const size = page.viewportSize()
  const needed = await page.evaluate((list) => {
    const rects = list
      .map((selector) => document.querySelector(selector))
      .filter(Boolean)
      .map((element) => element.getBoundingClientRect())
    if (rects.length === 0) return null
    return Math.max(...rects.map((r) => r.bottom)) - Math.min(...rects.map((r) => r.top))
  }, selectors)
  if (!needed) return
  await page.setViewportSize({ width: size.width, height: Math.ceil(needed + pad * 2) })
  await page.waitForTimeout(250)
}

/**
 * Frames a sheet shot: the sheet itself plus enough of the dimmed device
 * behind it to show what it is covering, rather than a screen of backdrop.
 */
async function shotSheet(page, name) {
  await settle(page)
  const box = await page.evaluate(() => {
    const sheet = document.querySelector('.fret-sheet')?.getBoundingClientRect()
    if (!sheet) return null
    const list = document.querySelector('.fret-list')?.getBoundingClientRect()
    return {
      right: sheet.right,
      // Stop below the list rather than at the sheet's full height, which is
      // mostly empty once the transfers run out.
      bottom: list ? list.bottom + 40 : sheet.bottom,
      width: window.innerWidth,
      height: window.innerHeight,
    }
  })
  if (!box) return shot(page, name)
  await page.screenshot({
    path: `${OUT}/${name}.png`,
    clip: {
      x: 0,
      y: 0,
      width: Math.min(box.width, box.right + 400),
      height: Math.min(box.height, box.bottom),
    },
  })
  console.log(`  ${name}.png`)
}

async function open({ viewport, theme = 'light', signedIn = true }) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 2,
    colorScheme: theme,
  })
  const page = await context.newPage()
  if (signedIn) {
    await page.goto(`${BASE}/demo-login`, { waitUntil: 'networkidle' })
    // The theme is stored per account, so it is set through the app's own
    // settings rather than by poking at the DOM.
    await page.evaluate(
      (value) =>
        fetch('/api/me/preferences', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ theme: value }),
        }),
      theme,
    )
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForTimeout(250)
  }
  return { context, page }
}

/** Builds an in-memory file for the upload shots. */
function payload(name, bytes) {
  const buffer = Buffer.alloc(bytes)
  for (let i = 0; i < bytes; i += 4096) buffer[i] = i % 251
  return { name, mimeType: 'application/octet-stream', buffer }
}

async function captureSignIn() {
  const context = await browser.newContext({ viewport: CARD, deviceScaleFactor: 2 })
  const page = await context.newPage()
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.fret-key')
  await fitViewport(page, ['.fret-panel'])
  await shotFramed(page, 'signin', ['.fret-panel'])
  await context.close()
}

async function captureEmpty(theme) {
  const { context, page } = await open({ viewport: DEVICE, theme })
  await page.waitForSelector('.fret-screen__title')
  await fitViewport(page, APP)
  await shotFramed(page, `empty-${theme}`, APP)
  await context.close()
}

async function captureUploadAndReady() {
  const { context, page } = await open({ viewport: DEVICE_TALL })

  // Slow the part uploads so the rising material and the sheen are caught in
  // motion rather than already finished.
  await page.route('**/*', async (route) => {
    const request = route.request()
    if (request.method() === 'PUT' && request.url().includes('/fret/transfers/')) {
      await new Promise((r) => setTimeout(r, 1200))
    }
    await route.continue()
  })

  await page.setInputFiles('input[type=file]', [
    payload('reel_autumn_v4_prores.mov', 34 << 20),
    payload('reel_autumn_v4_h264.mp4', 12 << 20),
    payload('cover_still_4k.png', 3 << 20),
    payload('grade_notes.pdf', 512 << 10),
  ])

  await page.waitForFunction(
    () => {
      const n = Number(document.querySelector('.fret-readout__value')?.textContent)
      return Number.isFinite(n) && n > 15 && n < 75
    },
    undefined,
    { timeout: 90_000 },
  )
  await fitViewport(page, APP)
  await shotFramed(page, 'uploading', APP)

  await page.waitForFunction(
    () => document.querySelector('.fret-screen__stripLabel')?.textContent === 'upload complete',
    undefined,
    { timeout: 180_000 },
  )
  await page.waitForTimeout(1000) // let the material finish draining
  await fitViewport(page, APP)
  await shotFramed(page, 'ready', APP)

  await context.close()
}

async function captureSheet(theme) {
  const { context, page } = await open({ viewport: WIDE, theme })
  await page.click('.fret-pill')
  await page.waitForTimeout(500)
  // Expand a row so the action grid shows.
  await page.locator('.fret-row__main').first().click()
  await page.waitForTimeout(400)
  await shotSheet(page, `sheet-${theme}`)
  await context.close()
}

async function captureSettings() {
  const { context, page } = await open({ viewport: DEVICE_TALL })
  await page.locator('.fret-iconpill').nth(1).click()
  await page.waitForSelector('.fret-popover')
  // The superadmin block arrives with its own request.
  await page.waitForSelector('.fret-admin', { timeout: 10_000 }).catch(() => {})
  await fitViewport(page, ['.fret-chrome', '.fret-popover'])
  await shotFramed(page, 'settings', ['.fret-chrome', '.fret-popover'])
  await context.close()
}

async function captureEdit() {
  const { context, page } = await open({ viewport: WIDE })
  await page.click('.fret-pill')
  await page.waitForTimeout(400)
  await page.locator('.fret-row__main').first().click()
  await page.waitForTimeout(400)
  await page.locator('.fret-action').nth(1).click()
  await page.waitForSelector('.fret-modal')
  await shot(page, 'edit')
  await context.close()
}

async function captureRecipient() {
  const context = await browser.newContext({ viewport: DEVICE_TALL, deviceScaleFactor: 2 })
  const page = await context.newPage()
  await page.goto(`${BASE}/client-review-oct`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.fret-filelist__row')
  await fitViewport(page, ['.fret-panel'])
  await shotFramed(page, 'recipient', ['.fret-panel'])
  await context.close()
}

async function captureRecipientLocked() {
  const context = await browser.newContext({
    viewport: DEVICE,
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  })
  const page = await context.newPage()
  await page.goto(`${BASE}/masters-hifi`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.fret-screen__title')
  await fitViewport(page, ['.fret-panel'])
  await shotFramed(page, 'recipient-locked', ['.fret-panel'])
  await context.close()
}

async function captureMobile() {
  const { context, page } = await open({ viewport: MOBILE })
  await page.click('.fret-pill')
  await page.waitForTimeout(600)
  await page.locator('.fret-row__main').first().click()
  await page.waitForTimeout(400)
  await shot(page, 'mobile-sheet')
  await context.close()
}

async function main() {
  await mkdir(OUT, { recursive: true })
  // FRET_CHROMIUM lets an environment with a preinstalled browser point at it
  // rather than having Playwright fetch a matching build.
  browser = await chromium.launch(
    process.env.FRET_CHROMIUM ? { executablePath: process.env.FRET_CHROMIUM } : {},
  )
  console.log(`capturing into ${OUT}`)

  await captureSignIn()
  await captureEmpty('light')
  await captureEmpty('dark')
  await captureUploadAndReady()
  await captureSheet('light')
  await captureSheet('dark')
  await captureSettings()
  await captureEdit()
  await captureRecipient()
  await captureRecipientLocked()
  await captureMobile()

  await browser.close()
  console.log('done')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
