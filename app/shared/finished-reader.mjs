// 工作台与离线 HTML 使用同一份文档、样式及交互；调用方仅提供图片地址。
const escapeHtml = value => String(value).replace(/[&<>"']/g, char => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]);

function startReader() {
  const viewport = document.querySelector(".finished-reader");
  const pages = [...viewport.querySelectorAll("figure")];
  const counter = document.querySelector(".reader-number");
  const toolbar = document.querySelector('.reader-toolbar');
  const toggle = document.querySelector('.reader-toggle');
  const zoomLabel = document.querySelector('.reader-zoom');
  const previous = document.querySelector('[data-page-step="-1"]');
  const next = document.querySelector('[data-page-step="1"]');
  function showToolbar(open){toolbar.hidden=!open;toggle.hidden=open;toggle.setAttribute('aria-expanded',String(open));}
  toggle.addEventListener('click',()=>showToolbar(toolbar.hidden));
  document.querySelector('[data-close-tools]').addEventListener('click',()=>{showToolbar(false);toggle.focus();});
  viewport.addEventListener('click',event=>{if(!event.target.closest('button,a,input,video[controls]'))showToolbar(toolbar.hidden);});
  const direction = document.querySelector('[data-direction-toggle]');
  const animations = [...viewport.querySelectorAll('video[data-autoplay]')];
  const visibleAnimations = new Set();
  const playVisible = video => {
    if(document.hidden||!visibleAnimations.has(video)){video.pause();return;}
    if(!video.getAttribute('src'))video.src=video.dataset.src;
    const playing=video.play();
    if(playing&&playing.catch)playing.catch(()=>{if(visibleAnimations.has(video)&&!document.hidden)video.parentElement.querySelector('[data-play-animation]').hidden=false;});
  };
  const animationObserver = typeof IntersectionObserver==='function'?new IntersectionObserver(entries=>{
    for(const entry of entries){
      if(entry.isIntersecting)visibleAnimations.add(entry.target);else visibleAnimations.delete(entry.target);
      playVisible(entry.target);
    }
  },{root:viewport,threshold:0.01}):null;
  animations.forEach(video=>{
    if(animationObserver)animationObserver.observe(video);
    const button=video.parentElement.querySelector('[data-play-animation]');
    button.addEventListener('click',()=>playVisible(video));
    video.addEventListener('playing',()=>{button.hidden=true;});
    video.addEventListener('error',()=>{button.hidden=false;button.textContent='动画无法播放，请用浏览器打开';button.disabled=true;});
  });
  function checkAnimations(){
    if(animationObserver)return;
    const area=viewport.getBoundingClientRect();
    animations.forEach(video=>{const rect=video.getBoundingClientRect();const visible=rect.bottom>area.top&&rect.top<area.bottom&&rect.right>area.left&&rect.left<area.right;
      if(visible){visibleAnimations.add(video);if(video.paused)playVisible(video);}else{visibleAnimations.delete(video);video.pause();}
    });
  }
  document.addEventListener('pointerup',()=>visibleAnimations.forEach(video=>{if(video.paused)playVisible(video);}));
  document.addEventListener('visibilitychange',()=>animations.forEach(playVisible));
  for(const image of viewport.querySelectorAll('img'))image.addEventListener('error',()=>{
    image.hidden=true;const message=document.createElement('p');message.className='reader-placeholder';message.textContent=`第 ${image.closest('figure').dataset.page} 页 · 成品文件已不可用`;image.closest('figure').append(message);
  },{once:true});
  for (const button of viewport.querySelectorAll('[data-original]')) button.addEventListener('click', () => {
    const original = button.closest('figure').querySelector('video');
    const preview = button.closest('figure').querySelector('img');
    if(!original){
      if(button.dataset.opened==='true'){
        preview.src=button.dataset.preview;button.dataset.opened='false';button.textContent='查看原图';return;
      }
      button.disabled=true;button.textContent='原图准备中…';
      const image=new Image();
      image.onload=()=>{preview.src=button.dataset.original;preview.hidden=false;preview.closest('figure').querySelector('.reader-placeholder')?.remove();button.dataset.opened='true';button.disabled=false;button.textContent='返回动图预览';};
      image.onerror=()=>{button.disabled=false;button.textContent='原图加载失败，重试';};
      image.src=button.dataset.original;return;
    }
    const opening = original.hidden;
    original.hidden = !opening; preview.hidden = opening;
    button.textContent = opening ? '返回动图预览' : '查看原图';
    if (opening) { original.src = button.dataset.original; original.play().catch(() => {}); }
    else { original.pause(); original.removeAttribute('src'); original.load(); }
  });
  let current = pages[0], horizontal = false, frame = 0, zoom = 1;
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
    previous.disabled=!current||current===pages[0];next.disabled=!current||current===pages[pages.length-1];
    checkAnimations();
  }
  function align() {
    if (!current) return;
    const area = viewport.getBoundingClientRect(), rect = current.getBoundingClientRect();
    viewport.scrollTo({ left: horizontal ? viewport.scrollLeft + rect.left - area.left : 0,
      top: horizontal ? 0 : viewport.scrollTop + rect.top - area.top, behavior: "auto" });
  }
  function layout(preserve=true){
    const area=viewport.getBoundingClientRect(),old=current&&current.getBoundingClientRect();
    const anchor=old?{x:(area.left+area.width*.5-old.left)/old.width,y:(area.top+area.height*.4-old.top)/old.height}:null;
    pages.forEach(page=>{
      const ratio=page.style.getPropertyValue('--ratio').split('/').map(Number);
      page.style.maxWidth='none';
      page.style.width=(horizontal?viewport.clientHeight*ratio[0]/ratio[1]:Math.min(viewport.clientWidth,900))*zoom+'px';
      page.style.height=horizontal?viewport.clientHeight*zoom+'px':'';
    });
    // 末页较小时也能滚到阅读起点，避免跳到末页后页码又落回前一页。
    const last=pages.length?pages[pages.length-1].getBoundingClientRect():null;
    viewport.style.paddingRight=horizontal&&last?Math.max(0,viewport.clientWidth-last.width)+'px':'0';
    viewport.style.paddingBottom=!horizontal&&last?Math.max(0,viewport.clientHeight-last.height)+'px':'0';
    zoomLabel.textContent=Math.round(zoom*100)+'%';
    document.querySelector('[data-zoom="out"]').disabled=zoom<=.5;
    document.querySelector('[data-zoom="in"]').disabled=zoom>=3;
    if(preserve&&anchor){const rect=current.getBoundingClientRect();viewport.scrollLeft+=rect.left-area.left+anchor.x*rect.width-area.width*.5;viewport.scrollTop+=rect.top-area.top+anchor.y*rect.height-area.height*.4;}
    update();
  }
  function setZoom(value){update();zoom=Math.max(.5,Math.min(3,Math.round(value*100)/100));layout();}
  function goTo(index){current=pages[Math.max(0,Math.min(pages.length-1,index))];align();update();}
  for(const button of document.querySelectorAll('[data-page-step]'))button.addEventListener('click',()=>{update();goTo(pages.indexOf(current)+Number(button.dataset.pageStep));});
  for(const button of document.querySelectorAll('[data-zoom]'))button.addEventListener('click',()=>setZoom(button.dataset.zoom==='fit'?1:zoom+(button.dataset.zoom==='in'?.25:-.25)));
  direction.addEventListener("click", () => {
    update(); horizontal = !horizontal;
    viewport.classList.toggle("is-horizontal", horizontal);
    direction.setAttribute('aria-checked',String(horizontal));
    direction.textContent=horizontal?'水平':'垂直';
    const selected=current;layout(false);current=selected;align();update();
  });
  viewport.addEventListener("scroll", () => { if (!frame) frame = requestAnimationFrame(update); }, { passive: true });
  viewport.addEventListener("wheel", event => {
    if (!horizontal || event.ctrlKey || zoom>1) return;
    const delta = Math.abs(event.deltaX) > Math.abs(event.deltaY) ? event.deltaX : event.deltaY;
    if (!delta) return;
    event.preventDefault();
    viewport.scrollLeft += delta * (event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? viewport.clientWidth : 1);
  }, { passive: false });
  document.addEventListener("keydown", event => {
    if(event.key==='Escape'){
      if(!toolbar.hidden){showToolbar(false);toggle.focus();}
      else if(window.parent!==window)window.parent.postMessage({type:'finished-reader-close'},'*');
      return;
    }
    if(event.ctrlKey||event.metaKey||event.altKey||event.target.closest('input,textarea,select,video[controls],[contenteditable="true"]'))return;
    if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){
      event.preventDefault();update();goTo(event.key==='Home'?0:event.key==='End'?pages.length-1:pages.indexOf(current)+(event.key==='ArrowLeft'?-1:1));return;
    }
    if(['+','=','-','0'].includes(event.key)){event.preventDefault();setZoom(event.key==='0'?1:zoom+(event.key==='-'?-.25:.25));return;}
    if(event.key.toLowerCase()==='m'){event.preventDefault();showToolbar(toolbar.hidden);return;}
    const step = horizontal ? viewport.clientWidth * .8 : viewport.clientHeight * .8;
    if (["ArrowDown", "ArrowUp",'PageDown','PageUp',' '].includes(event.key)&&!(event.key===' '&&event.target instanceof HTMLButtonElement)) {
      event.preventDefault();
      const delta = ['ArrowUp','PageUp'].includes(event.key)||event.key===' '&&event.shiftKey ? -step : step;
      viewport.scrollBy({ left: horizontal ? delta : 0, top: horizontal ? 0 : delta });
    }
  });
  const resize=()=>{const selected=current;layout(false);current=selected;align();update();};
  if(typeof ResizeObserver==='function')new ResizeObserver(resize).observe(viewport);else window.addEventListener('resize',resize);
  layout(false);
}

export function finishedReaderHead(title = "成品预览",locale='zh') {
  return `<!doctype html>
<html lang="${locale==='en'?'en':locale==='ja'?'ja':'zh-CN'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title>
<style>
*{box-sizing:border-box}html,body{margin:0;width:100%;height:100%;overflow:hidden;background:#202923;font-family:system-ui,sans-serif}
.finished-reader{width:100%;height:100vh;height:100dvh;overflow:auto;overscroll-behavior:contain;scrollbar-width:none}
.finished-reader::-webkit-scrollbar{display:none}
figure{margin:0 auto 4px;width:100%;max-width:900px;line-height:0}
img,video{width:100%;height:auto;display:block}
[hidden]{display:none!important}figure{position:relative}.reader-original{position:absolute;bottom:12px;left:12px;line-height:1.4;background:rgba(251,252,249,.9);z-index:1}
video:not([hidden])+.reader-original{bottom:76px}
.is-horizontal{display:flex;gap:4px;overflow-y:auto}
.is-horizontal figure{flex:none;width:auto;height:100%;margin:0;aspect-ratio:var(--ratio)}
.is-horizontal img,.is-horizontal video{width:100%;height:auto;max-width:none}
.reader-toolbar{position:fixed;left:8px;right:8px;bottom:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));margin:0 auto;width:max-content;max-width:calc(100% - 16px);display:flex;align-items:center;gap:4px;padding:4px;border:1px solid #a2b2aa;border-radius:12px;background:rgba(251,252,249,.97);color:#172126;box-shadow:0 4px 20px #0004;z-index:2;white-space:nowrap}
.reader-toolbar button{flex:none;min-width:32px;padding:5px 8px}.reader-toolbar output{font-variant-numeric:tabular-nums}.reader-toggle{position:fixed;right:12px;bottom:12px;bottom:calc(12px + env(safe-area-inset-bottom,0px));padding:6px 12px;color:white;background:#172a22dc;z-index:2;font-variant-numeric:tabular-nums}.reader-toggle output{pointer-events:none}.reader-play{position:absolute;left:12px;bottom:12px;background:#fbfcf9ee;line-height:1.5}
figure{position:relative}.reader-placeholder{display:grid;place-items:center;width:min(90vw,700px);min-height:75vh;margin:0;color:#d6ded9;background:#303a34;text-align:center;padding:32px}.reader-stale{position:absolute;top:8px;left:8px;padding:4px 8px;background:#3a2d1ccc;color:white;font-size:12px}
button{font:600 13px system-ui,sans-serif;color:#172126;background:transparent;border:0;border-radius:7px;min-height:34px;padding:5px 12px;cursor:pointer}
button[aria-checked=true]{background:#e3efe8;color:#2d6a55}
button:disabled{opacity:.45;cursor:default}button:focus-visible,input:focus-visible{outline:2px solid #42866b;outline-offset:2px}.reader-noscript{position:fixed;top:0;left:0;right:0;padding:12px;background:#fbfcf9;color:#172126;z-index:3}
@media(pointer:coarse){button{min-height:44px}}
</style></head><body><noscript><p class="reader-noscript">此打开方式无法使用阅读工具和动画。请保存文件后，用 Chrome 等浏览器打开。</p></noscript><nav id="reader-tools" class="reader-toolbar" aria-label="阅读工具栏" hidden>
<button type="button" data-page-step="-1" aria-label="上一页">←</button><button type="button" data-page-step="1" aria-label="下一页">→</button><button type="button" data-direction-toggle role="switch" aria-label="水平阅读" aria-checked="false">垂直</button><button type="button" data-zoom="out" aria-label="缩小">−</button><button type="button" data-zoom="fit" aria-label="适合屏幕"><output class="reader-zoom" aria-label="缩放比例">100%</output></button><button type="button" data-zoom="in" aria-label="放大">＋</button><button type="button" data-close-tools aria-label="收起工具栏">×</button></nav><button type="button" class="reader-toggle" aria-label="阅读工具" aria-controls="reader-tools" aria-expanded="false">第 <output class="reader-number" aria-label="当前页码"></output> 页 · 工具</button><main class="finished-reader" tabindex="0" aria-label="连续阅读"><!-- 图片 -->
`;
}
export function finishedReaderFigure(src, number, width, height, mediaKind = "image", originalSrc,message='',stale=false) {
  if(!src)return `<figure data-page="${Number(number)}" style="--ratio:${Number(width)}/${Number(height)}"><p class="reader-placeholder">第 ${Number(number)} 页 · ${escapeHtml(message||'尚未制作')}</p></figure>\n`;
  if (mediaKind === 'video' && originalSrc) return `<figure data-page="${Number(number)}" style="--ratio:${Number(width)}/${Number(height)}"><img loading="lazy" src="${escapeHtml(src)}" width="${Number(width)}" height="${Number(height)}" alt="第 ${Number(number)} 页动态预览"><video hidden controls muted loop playsinline preload="none" width="${Number(width)}" height="${Number(height)}" aria-label="第 ${Number(number)} 页原图视频"></video><button type="button" class="reader-original" data-original="${escapeHtml(originalSrc)}">查看原图</button></figure>\n`;
  if(mediaKind === "video") return `<figure data-page="${Number(number)}" style="--ratio:${Number(width)}/${Number(height)}"><video controls muted loop playsinline preload="metadata" src="${escapeHtml(src)}" width="${Number(width)}" height="${Number(height)}" aria-label="第 ${Number(number)} 页动态画面"></video></figure>\n`;
  return `<figure data-page="${Number(number)}" style="--ratio:${Number(width)}/${Number(height)}"><img loading="lazy" src="${escapeHtml(src)}" width="${Number(width)}" height="${Number(height)}" alt="第 ${Number(number)} 页">${originalSrc?`<button type="button" class="reader-original" data-preview="${escapeHtml(src)}" data-original="${escapeHtml(originalSrc)}">查看原图</button>`:''}${stale?'<figcaption class="reader-stale">旧版成品 · 内容已变化</figcaption>':''}</figure>\n`;
}
export function finishedReaderAnimation(src,number,width,height) {
  return `<figure data-page="${Number(number)}" style="--ratio:${Number(width)}/${Number(height)}"><video data-autoplay data-src="${escapeHtml(src)}" muted loop playsinline webkit-playsinline x5-playsinline preload="none" disablepictureinpicture style="pointer-events:none" width="${Number(width)}" height="${Number(height)}" aria-label="第 ${Number(number)} 页动态画面"></video><button type="button" class="reader-play" data-play-animation hidden>播放动画</button></figure>\n`;
}
export const finishedReaderTail = `</main><script>(${startReader.toString()})()</script></body></html>\n`;
export function finishedReaderDocument(pages, title,locale='zh') {
  return finishedReaderHead(title,locale) + pages.map(page => finishedReaderFigure(page.src, page.number, page.width, page.height, page.media_kind, page.original_src,page.message,page.stale)).join("") + finishedReaderTail;
}
