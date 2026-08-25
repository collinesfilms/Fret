/**
 * Captures the screenshots used in the README.
 *
 * Start a *fresh* demo server first, then run this:
 *
 *   go run ./cmd/fret-demo
 *   cd web && npm run screenshots
 *
 * Fresh matters: the captures create and rename transfers, so a second run
 * against the same process collides with the names the first one claimed.
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
 * Shots are full-window captures. The device is a fixed width centred in the
 * viewport and the space around it is part of the design, so these are sized
 * like a real window rather than cropped to the panel.
 */
const DESKTOP = { width: 1180, height: 800 }
const DESKTOP_TALL = { width: 1180, height: 940 }
const MOBILE = { width: 414, height: 820 }

let browser

/**
 * Waits for the page to be worth photographing: fonts loaded, and the blinking
 * caret pinned on so a shot cannot land in the half of the cycle where it is
 * invisible.
 */
async function settle(page, ms = 400) {
  await page.addStyleTag({
    content: '.fret-caret { animation: none !important; opacity: 1 !important; }',
  })
  await page.evaluate(() => document.fonts.ready)
  await page.waitForTimeout(ms)

  // Jump every finite animation to its end.
  //
  // The device fades in on mount, and mount happens only after the app has
  // fetched its config and session — so on a slow load the entry animation is
  // still running when a fixed wait expires, and the shot catches a
  // half-transparent panel with a washed-out screen. Waiting longer only moves
  // the race; this ends it. Infinite animations (lamps, the sheen) cannot
  // finish and are left running, which is what keeps them looking alive.
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      try {
        animation.finish()
      } catch {
        // Infinite: nothing to finish.
      }
    }
  })
  await page.waitForTimeout(120)
}

async function shot(page, name) {
  await settle(page)
  await page.screenshot({ path: `${OUT}/${name}.png` })
  console.log(`  ${name}.png`)
}

/** Opens a context with the demo session already established. */
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
    // The app mounts only after /api/config and /api/me answer, and the demo
    // server does occasionally reset a connection when several browser
    // contexts hit it at once — leaving a blank page that every later locator
    // then waits out in full. One reload covers that; a second failure is
    // real, and says so rather than timing out somewhere less obvious.
    try {
      await page.waitForSelector('.fret-chrome', { timeout: 15_000 })
    } catch {
      await page.reload({ waitUntil: 'networkidle' })
      await page.waitForSelector('.fret-chrome', { timeout: 15_000 })
    }
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
  const context = await browser.newContext({ viewport: DESKTOP, deviceScaleFactor: 2 })
  const page = await context.newPage()
  await page.goto(BASE, { waitUntil: 'networkidle' })
  await page.waitForSelector('.fret-key')
  await shot(page, 'signin')
  await context.close()
}

async function captureEmpty(theme) {
  const { context, page } = await open({ viewport: DESKTOP, theme })
  await page.waitForSelector('.fret-screen__title')
  await shot(page, `empty-${theme}`)
  await context.close()
}

async function captureUploadAndReady() {
  const { context, page } = await open({ viewport: DESKTOP_TALL })

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
  await shot(page, 'uploading')

  await page.waitForFunction(
    () => document.querySelector('.fret-screen__stripLabel')?.textContent === 'upload complete',
    undefined,
    { timeout: 180_000 },
  )
  await page.waitForTimeout(1000) // let the material finish draining
  await shot(page, 'ready')

  await context.close()
}

/**
 * The options tray, out from under the device. The password is set, so its
 * Clear is live while the link's action still offers another draw.
 */
async function captureTray() {
  const { context, page } = await open({ viewport: DESKTOP_TALL })

  await page.setInputFiles('input[type=file]', [
    payload('reel_autumn_v4_prores.mov', 3 << 20),
    payload('grade_notes.pdf', 180 << 10),
  ])
  await page.waitForFunction(
    () => document.querySelector('.fret-screen__stripLabel')?.textContent === 'upload complete',
    undefined,
    { timeout: 120_000 },
  )
  await page.waitForTimeout(1000)

  await page.locator('.fret-actions__secondary').first().click()
  await page.waitForSelector('.fret-tray--open')
  await page.waitForTimeout(700)

  const password = page.locator('.fret-tray input[type=password]')
  await password.fill('listen')
  await password.press('Enter')
  await page.waitForTimeout(600)

  await shot(page, 'options-tray')
  await context.close()
}

/** The same drawer at phone width, where it runs the full width of the device. */
async function captureMobileTray() {
  const { context, page } = await open({ viewport: MOBILE })

  await page.setInputFiles('input[type=file]', [payload('reel_autumn_v4_prores.mov', 3 << 20)])
  await page.waitForFunction(
    () => document.querySelector('.fret-screen__stripLabel')?.textContent === 'upload complete',
    undefined,
    { timeout: 120_000 },
  )
  await page.waitForTimeout(900)

  await page.locator('.fret-actions__secondary').first().click()
  await page.waitForSelector('.fret-tray--open')
  await page.waitForTimeout(700)

  await shot(page, 'mobile-tray')
  await context.close()
}

async function captureSheet(theme) {
  const { context, page } = await open({ viewport: DESKTOP_TALL, theme })
  await page.click('.fret-pill')
  await page.waitForTimeout(500)
  // Expand a row so the action grid shows.
  await page.locator('.fret-row__main').first().click()
  await page.waitForTimeout(400)
  await shot(page, `sheet-${theme}`)
  await context.close()
}

async function captureSettings() {
  const { context, page } = await open({ viewport: DESKTOP_TALL })
  await page.locator('.fret-iconpill').nth(1).click()
  await page.waitForSelector('.fret-popover')
  // The superadmin block arrives with its own request.
  await page.waitForSelector('.fret-admin', { timeout: 10_000 }).catch(() => {})
  await shot(page, 'settings')
  await context.close()
}

/**
 * The edit modal mid-rename. This is the one place a rename can cost
 * anything — the transfer is live and its link has been handed out — so the
 * shot is taken with the field changed, showing what the modal says about it.
 */
async function captureEdit() {
  const { context, page } = await open({ viewport: DESKTOP_TALL })
  await page.click('.fret-pill')
  await page.waitForTimeout(400)

  // Search for a seeded transfer by name rather than taking the first row.
  // The upload shots run before this one and leave their transfers at the top
  // of the list, and those have never been copied — so renaming one costs
  // nothing and the modal correctly says nothing, which is not the state this
  // shot exists to show.
  await page.locator('.fret-sheet input.fret-field').fill('client-review-oct')
  await page.waitForTimeout(400)
  await page.locator('.fret-row__main').first().click()
  await page.waitForTimeout(400)
  await page.locator('.fret-rowaction').nth(1).click()
  await page.waitForSelector('.fret-modal')
  await page.locator('#edit-slug').fill('autumn-review-v5')
  await page.waitForTimeout(600)
  await shot(page, 'edit')
  await context.close()
}

async function captureRecipient() {
  const context = await browser.newContext({ viewport: DESKTOP_TALL, deviceScaleFactor: 2 })
  const page = await context.newPage()
  await page.goto(`${BASE}/client-review-oct`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.fret-filelist__row')
  await shot(page, 'recipient')
  await context.close()
}

async function captureRecipientLocked() {
  const context = await browser.newContext({
    viewport: DESKTOP,
    deviceScaleFactor: 2,
    colorScheme: 'dark',
  })
  const page = await context.newPage()
  await page.goto(`${BASE}/masters-hifi`, { waitUntil: 'networkidle' })
  await page.waitForSelector('.fret-screen__title')
  await shot(page, 'recipient-locked')
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

/*
 * Named so a single shot can be re-taken without the other twelve. A full run
 * drives real uploads through a real browser and takes minutes; a design tweak
 * that only touches one screen should not cost all of them.
 *
 *   npm run screenshots            every shot
 *   npm run screenshots -- edit    just captureEdit
 */
const SHOTS = {
  signin: captureSignIn,
  'empty-light': () => captureEmpty('light'),
  'empty-dark': () => captureEmpty('dark'),
  // One pass through a real upload, photographed twice: uploading.png and
  // ready.png both come out of this.
  upload: captureUploadAndReady,
  'options-tray': captureTray,
  'mobile-tray': captureMobileTray,
  'sheet-light': () => captureSheet('light'),
  'sheet-dark': () => captureSheet('dark'),
  settings: captureSettings,
  edit: captureEdit,
  recipient: captureRecipient,
  'recipient-locked': captureRecipientLocked,
  'mobile-sheet': captureMobile,
}

async function main() {
  await mkdir(OUT, { recursive: true })

  const wanted = process.argv.slice(2)
  const unknown = wanted.filter((name) => !(name in SHOTS))
  if (unknown.length > 0) {
    console.error(`unknown shot(s): ${unknown.join(', ')}`)
    console.error(`available: ${Object.keys(SHOTS).join(', ')}`)
    process.exit(1)
  }
  // FRET_CHROMIUM lets an environment with a preinstalled browser point at it
  // rather than having Playwright fetch a matching build.
  browser = await chromium.launch(
    process.env.FRET_CHROMIUM ? { executablePath: process.env.FRET_CHROMIUM } : {},
  )
  console.log(`capturing into ${OUT}`)

  for (const [name, capture] of Object.entries(SHOTS)) {
    if (wanted.length === 0 || wanted.includes(name)) await capture()
  }

  await browser.close()
  console.log('done')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
