import { _electron as electron, expect, test, type ElectronApplication, type Page } from '@playwright/test'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

let app: ElectronApplication
let page: Page
let profileDir: string

test.beforeAll(async () => {
  const { ELECTRON_RUN_AS_NODE: _electronRunAsNode, ...env } = process.env
  profileDir = await mkdtemp(path.join(os.tmpdir(), 'handcash-e2e-'))
  app = await electron.launch({
    args: ['.', `--user-data-dir=${profileDir}`],
    env: {
      ...env,
      XDG_CONFIG_HOME: profileDir,
      HANDCASH_E2E: '1',
    },
  })
  page = await app.firstWindow()
  await page.waitForLoadState('domcontentloaded')
  await expect(page.locator('#root')).not.toBeEmpty()
})

test.afterAll(async () => {
  await app?.close()
  if (profileDir) await rm(profileDir, { recursive: true, force: true })
})

test('boots the real Electron renderer', async () => {
  await expect(page).toHaveTitle('HandCash')
  await expect(page.locator('body')).toBeVisible()
})

test('activity subscripts stay centered on thumbnail corners', async () => {
  await page.setViewportSize({ width: 480, height: 260 })
  await page.evaluate(async () => {
    document.documentElement.classList.remove('dark')
    document.documentElement.classList.add('light')
    document.body.innerHTML = `
      <main class="visual-fixture" aria-label="Activity badge visual fixture">
        <div class="history-icon-wrap">
          <div class="history-icon fixture-coin">₿</div>
          <span class="history-action-badge is-failed" aria-label="Failed">
            <svg aria-hidden="true" viewBox="0 0 24 24" width="9" height="9" fill="currentColor">
              <path d="M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z"></path>
            </svg>
          </span>
        </div>
        <div class="history-icon-wrap">
          <div class="history-icon fixture-token">K</div>
          <span class="history-action-badge is-burn" aria-label="Burn">
            <svg aria-hidden="true" viewBox="0 0 24 24" width="8" height="8" fill="currentColor">
              <path d="M12 12.9l-2.13 2.09C9.31 15.55 9 16.28 9 17.06 9 18.68 10.35 20 12 20s3-1.32 3-2.94c0-.78-.31-1.52-.87-2.07L12 12.9zM16 6l-.44.55C14.38 8.02 12 7.19 12 5.3V2S5 6 5 12c0 3.87 3.13 7 7 7s7-3.13 7-7c0-2.92-1.63-5.29-3-6z"></path>
            </svg>
          </span>
        </div>
      </main>
    `
    const style = document.createElement('style')
    style.textContent = `
      body { margin: 0; background: #f7f7f5; }
      .visual-fixture {
        display: flex;
        gap: 48px;
        width: max-content;
        padding: 48px;
        background: #fff;
      }
      .fixture-coin {
        border-radius: 50%;
        background: #f5b900;
        color: #fff;
        font: 700 22px/1 system-ui, sans-serif;
      }
      .fixture-token {
        background: #f4f1e7;
        color: #1c1c1a;
        font: 700 18px/1 system-ui, sans-serif;
      }
    `
    document.head.appendChild(style)
    await document.fonts.ready
  })

  await expect(page.getByLabel('Activity badge visual fixture')).toHaveScreenshot(
    'activity-badges.png',
  )
})
