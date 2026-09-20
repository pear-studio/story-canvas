import { chromium } from "playwright";
import sharp from "sharp";

const launchBrowser = () => chromium.launch(process.platform === "win32" ? { channel: "msedge", headless: true } : { headless: true });

// 与编辑器使用同一个 React 组件和 CSS，只渲染透明文字层，底图保留原始像素。
export async function renderFinishedImage(clean, lettering, origin) {
  const { width, height } = await sharp(clean).metadata();
  const browser = await launchBrowser();
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(`${origin}/finished-render.html`);
    await page.waitForFunction(() => typeof window.renderFinishedLettering === "function");
    await page.evaluate(value => window.renderFinishedLettering(value), lettering);
    const overlay = await page.screenshot({ omitBackground: true, animations: "disabled" });
    return await sharp(clean).composite([{ input: overlay }]).png().toBuffer();
  } finally { await browser.close(); }
}

// 批量输出共享一个无头浏览器：页面与字体只加载一次，逐页复用渲染；浏览器崩溃时重试一次。
export function createFinishedRenderer(origin) {
  let state = null;
  async function open(width, height) {
    const browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    await page.goto(`${origin}/finished-render.html`);
    await page.waitForFunction(() => typeof window.renderFinishedLettering === "function");
    return { browser, page, width, height };
  }
  async function render(clean, lettering) {
    const { width, height } = await sharp(clean).metadata();
    for (let attempt = 0; ; attempt += 1) {
      try {
        if (!state) state = await open(width, height);
        if (state.width !== width || state.height !== height) {
          await state.page.setViewportSize({ width, height });
          state = { ...state, width, height };
        }
        await state.page.evaluate(value => window.renderFinishedLettering(value), lettering);
        const overlay = await state.page.screenshot({ omitBackground: true, animations: "disabled" });
        return await sharp(clean).composite([{ input: overlay }]).png().toBuffer();
      } catch (error) {
        const broken = !state?.browser.isConnected() || /closed|crashed/i.test(error?.message ?? "");
        await close();
        if (broken && attempt === 0) continue;
        throw error;
      }
    }
  }
  async function close() {
    const current = state;
    state = null;
    await current?.browser.close().catch(() => {});
  }
  return { render, close };
}
