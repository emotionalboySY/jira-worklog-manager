import { spawn } from 'node:child_process'
import { mkdir } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { chromium } from 'playwright'

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const outputDir = path.join(rootDir, 'screenshots')
const port = process.env.SCREENSHOT_PORT || '4173'
const baseUrl = `http://127.0.0.1:${port}`

const targets = [
  { name: '01-이슈-목록', query: 'view=issues' },
  { name: '02-작업-로그', query: 'view=logs' },
  { name: '03-주간-요약', query: 'view=summary&week=-1' },
]

function waitForServer(url, timeoutMs = 30_000) {
  const startedAt = Date.now()
  return new Promise((resolve, reject) => {
    const poll = async () => {
      try {
        const response = await fetch(url)
        if (response.ok) return resolve()
      } catch {}

      if (Date.now() - startedAt >= timeoutMs) {
        return reject(new Error(`개발 서버가 ${timeoutMs / 1000}초 안에 시작되지 않았습니다.`))
      }
      setTimeout(poll, 250)
    }
    poll()
  })
}

async function launchBrowser() {
  try {
    // 설치된 Chrome을 우선 사용해 별도 브라우저 설치 없이 촬영한다.
    return await chromium.launch({ channel: 'chrome', headless: true, args: ['--disable-gpu'] })
  } catch (chromeError) {
    try {
      return await chromium.launch({ headless: true, args: ['--disable-gpu'] })
    } catch {
      throw new Error(`브라우저를 실행할 수 없습니다. 먼저 'npx playwright install chromium'을 실행해주세요.\n${chromeError.message}`)
    }
  }
}

await mkdir(outputDir, { recursive: true })

const server = spawn(process.execPath, [
  path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js'),
  '--host', '127.0.0.1',
  '--port', port,
  '--strictPort',
], {
  cwd: rootDir,
  stdio: ['ignore', 'pipe', 'pipe'],
  windowsHide: true,
})

let browser
try {
  await waitForServer(baseUrl)
  browser = await launchBrowser()
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    deviceScaleFactor: 1,
    locale: 'ko-KR',
    timezoneId: 'Asia/Seoul',
    colorScheme: 'dark',
  })

  for (const target of targets) {
    const page = await context.newPage()
    await page.goto(`${baseUrl}/?demo=1&${target.query}`, { waitUntil: 'networkidle' })
    await page.locator('#app').waitFor({ state: 'visible' })
    await page.evaluate(() => document.fonts.ready)
    await page.waitForTimeout(500)
    await page.screenshot({
      path: path.join(outputDir, `${target.name}.png`),
      fullPage: false,
    })
    await page.close()
    console.log(`촬영 완료: screenshots/${target.name}.png`)
  }

  await context.close()
} finally {
  if (browser) await browser.close()
  server.kill()
}
