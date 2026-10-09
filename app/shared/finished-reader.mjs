// 工作台与离线 HTML 使用同一份文档、样式及交互；调用方仅提供图片地址。
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function startReader() {
  const viewport = document.querySelector(".finished-reader");
  const pages = [...viewport.querySelectorAll("figure")];
  const counter = document.querySelector(".reader-number");
  const controls = [...document.querySelectorAll("[data-direction]")];
  for (const button of viewport.querySelectorAll('[data-original]')) button.addEventListener('click', () => {
    const original = button.closest('figure').querySelector('video');
    const preview = button.closest('figure').querySelector('img');
    const opening = original.hidden;
    original.hidden = !opening; preview.hidden = opening;
    button.textContent = opening ? '返回动图预览' : '查看原图';
    if (opening) { original.src = button.dataset.original; original.play().catch(() => {}); }
    else { original.pause(); original.removeAttribute('src'); original.load(); }
  });
  let current = pages[0], horizontal = false, frame = 0;
  function update() {
    frame = 0;
    const area = viewport.getBoundingClientRect();
    const point = horizontal ? area.left + area.width * .4 : area.top + area.height * .4;
    let nearest = Infinity;
    for (const page of pages) {
      const rect = page.getBoundingClientRect();
      const start = horizontal ? rect.left : rect.top, end = horizontal ? rect.right : rect.bottom;
      const distance = Math.max(start - point, point - end, 0);
      if (distance < nearest) { nearest = distance; current = page; }
    }
    counter.textContent = current?.dataset.page ?? "";
  }
  function align() {
    if (!current) return;
    const area = viewport.getBoundingClientRect(), rect = current.getBoundingClientRect();
    viewport.scrollTo({ left: horizontal ? viewport.scrollLeft + rect.left - area.left : 0,
      top: horizontal ? 0 : viewport.scrollTop + rect.top - area.top, behavior: "instant" });
  }
  for (const button of controls) button.addEventListener("click", () => {
    update(); horizontal = button.dataset.direction === "horizontal";
    viewport.classList.toggle("is-horizontal", horizontal);
    controls.forEach(control => control.setAttribute("aria-pressed", String(control === button)));
    align();
  });
  viewport.addEventListener("scroll", () => { if (!frame) frame = requestAnimationFrame(update); }, { passive: true });
  viewport.addEventListener("wheel", event => {
    if (!horizontal || event.ctrlKey) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;
    event.preventDefault();
    viewport.scrollLeft += delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1);
  }, { passive: false });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape" && window.parent !== window) window.parent.postMessage({ type: "finished-reader-close" }, "*");
    if (event.target instanceof HTMLButtonElement || event.target instanceof HTMLVideoElement) return;
    const step = horizontal ? viewport.clientWidth * .8 : viewport.clientHeight * .8;
    if (["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp"].includes(event.key)) {
      event.preventDefault();
      const delta = ["ArrowLeft", "ArrowUp"].includes(event.key) ? -step : step;
      viewport.scrollBy({ left: horizontal ? delta : 0, top: horizontal ? 0 : delta });
    }
  });
  new ResizeObserver(align).observe(viewport);
  update();
}

export function finishedReaderHead(title = "成品预览") {
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#202923;font-family:system-ui,sans-serif}
.finished-reader{width:100%;height:100dvh;overflow:auto;overscroll-behavior:contain;scrollbar-width:none}
.finished-reader::-webkit-scrollbar{display:none}
figure{margin:0 auto 4px;width:min(100%,900px);line-height:0}
img,video{width:100%;height:auto;display:block}
[hidden]{display:none!important}figure{position:relative}.reader-original{position:absolute;bottom:12px;left:12px;line-height:1.4;background:rgba(251,252,249,.9);z-index:1}
video:not([hidden])+.reader-original{bottom:76px}
.is-horizontal{display:flex;gap:4px;overflow-y:hidden}
.is-horizontal figure{flex:none;width:auto;height:100%;margin:0;aspect-ratio:var(--ratio)}
.is-horizontal img,.is-horizontal video{width:auto;height:100%;max-width:none}
.reader-directions{position:fixed;left:12px;top:12px;display:flex;gap:3px;padding:3px;border-radius:9px;background:rgba(251,252,249,.9);z-index:1}
button{font:600 13px system-ui,sans-serif;color:#172126;background:transparent;border:0;border-radius:7px;min-height:34px;padding:5px 12px;cursor:pointer}
button[aria-pressed=true]{background:#e3efe8;color:#2d6a55}
.reader-number{position:fixed;right:12px;bottom:12px;padding:3px 9px;border-radius:5px;background:rgba(0,0,0,.5);color:white;font:12px/1.6 system-ui,sans-serif;pointer-events:none;font-variant-numeric:tabular-nums}
@media(pointer:coarse){button{min-height:44px}}
</style></head><body><nav class="reader-directions" aria-label="阅读方向"><button type="button" data-direction="vertical" aria-pressed="true">垂直</button><button type="button" data-direction="horizontal" aria-pressed="false">水平</button></nav><main class="finished-reader" tabindex="0" aria-label="连续阅读"><!-- 图片 -->
`;
}
export function finishedReaderFigure(src, number, width, height, mediaKind = "image", originalSrc) {
  if (mediaKind === 'video' && originalSrc) return `<figure data-page="${Number(number)}" style="--ratio:${Number(width)}/${Number(height)}"><img loading="lazy" src="${escapeHtml(src)}" width="${Number(width)}" height="${Number(height)}" alt="第 ${Number(number)} 页动态预览"><video hidden controls muted loop playsinline preload="none" width="${Number(width)}" height="${Number(height)}" aria-label="第 ${Number(number)} 页原图视频"></video><button type="button" class="reader-original" data-original="${escapeHtml(originalSrc)}">查看原图</button></figure>\n`;
  if(mediaKind === "video") return `<figure data-page="${Number(number)}" style="--ratio:${Number(width)}/${Number(height)}"><video controls muted loop playsinline preload="metadata" src="${escapeHtml(src)}" width="${Number(width)}" height="${Number(height)}" aria-label="第 ${Number(number)} 页动态画面"></video></figure>\n`;
  return `<figure data-page="${Number(number)}" style="--ratio:${Number(width)}/${Number(height)}"><img loading="lazy" src="${escapeHtml(src)}" width="${Number(width)}" height="${Number(height)}" alt="第 ${Number(number)} 页"></figure>\n`;
}
export const finishedReaderTail = `</main><output class="reader-number" aria-label="当前页码"></output><script>(${startReader.toString()})()</script></body></html>\n`;
export function finishedReaderDocument(pages, title) {
  return finishedReaderHead(title) + pages.map(page => finishedReaderFigure(page.src, page.number, page.width, page.height, page.media_kind, page.original_src)).join("") + finishedReaderTail;
}
