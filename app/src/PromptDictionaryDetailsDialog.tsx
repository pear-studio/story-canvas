import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { NavigationContextMenu, type NavigationMenuItem } from "./NavigationContextMenu";
import { useLongPressContextMenu } from "./use-long-press-context-menu";
import { normalizedPromptDisplay, promptDictionaryBatches, type PromptDictionaryDisplayScope, type PromptDictionaryMatch } from "./prompt-display";
import "./prompt-dictionary-details.css";

export const dictionaryCategoryLabels: Record<string, string> = { population: "人数", person: "人物", appearance: "外观", action: "动作", setting: "场景", camera: "镜头", avoid: "避免", identity: "身份", hair: "发型", face: "面部", body: "身体", clothing: "服装", accessories: "配饰", equipment: "装备" };
export function dictionaryFrequency(postCount: number | null | undefined) {
  if (!Number.isFinite(postCount)) return null;
  if ((postCount ?? 0) >= 1000) return { label: "常用", tone: "common" };
  if ((postCount ?? 0) >= 100) return { label: "低频", tone: "low" };
  return { label: "稀有", tone: "rare" };
}

export type DictionaryEditAction = "replace" | "insert" | "negative";
type Actions = { sourceLabel: string; canAddNegative: boolean; onUse: (action: DictionaryEditAction, entry: PromptDictionaryMatch) => boolean };
function wikiUrl(tag: string) {
  const source = tag.replaceAll(" ", "_");
  return `https://danbooru.donmai.us/wiki_pages/${encodeURIComponent(/^\d+$/.test(source) ? `~${source}` : source)}`;
}
function references(text: string) {
  return [...text.matchAll(/\[\[([^\[\]\n]+)\]\]/g)].map(match => {
    const [rawTarget, ...label] = match[1].split("|");
    return { text: match[0], index: match.index, target: rawTarget.split("#")[0].trim(), label: label.join("|").trim() };
  }).filter(reference => reference.target && reference.target.length <= 500);
}
function referenceLabel(target: string, entry?: PromptDictionaryMatch, label = "") {
  const english = normalizedPromptDisplay(entry?.source_text || target);
  const chinese = [label, entry?.display_text].find(value => value && /\p{Script=Han}/u.test(value));
  const display = chinese || label;
  return display && normalizedPromptDisplay(display) !== english ? `${display} · ${english}` : english;
}

export function PromptDictionaryDetailsDialog({ entry: initialEntry, scope, actions, onClose }: {
  entry: PromptDictionaryMatch; scope: PromptDictionaryDisplayScope; actions?: Actions; onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [pages, setPages] = useState([{ entry: initialEntry, scroll: 0 }]);
  const [notice, setNotice] = useState("");
  const [loading, setLoading] = useState(false);
  const [referenceEntries, setReferenceEntries] = useState<Record<string, PromptDictionaryMatch>>({});
  const [menu, setMenu] = useState<{ x: number; y: number; target: string; entry?: PromptDictionaryMatch; error?: string; current?: boolean } | null>(null);
  const serial = useRef(0);
  const requests = useRef(new Map<string, Promise<PromptDictionaryMatch>>());
  const controller = useRef<AbortController | null>(null);
  const longPress = useLongPressContextMenu();
  const entry = pages[pages.length - 1].entry;
  const sourceTag = entry.source_text || entry.prompt_text.replaceAll(" ", "_");
  const frequency = dictionaryFrequency(entry.post_count);
  const providerLabels: Record<string, string> = { "0": "通用标签", "1": "画师", "3": "作品", "4": "角色", "5": "元信息" };

  useLayoutEffect(() => {
    const dialog = dialogRef.current;
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    controller.current = new AbortController();
    dialog?.showModal();
    return () => {
      serial.current++;
      controller.current?.abort();
      requests.current.clear();
      dialog?.close();
      if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
    };
  }, []);
  useLayoutEffect(() => { if (contentRef.current) contentRef.current.scrollTop = pages[pages.length - 1].scroll; }, [pages]);
  useEffect(() => {
    let cancelled = false;
    const targets = [...new Set([...(entry.description_language === "zh" ? references(entry.description ?? "") : []), ...references(entry.original_description ?? "")].map(reference => reference.target))];
    if (targets.length) void lookupMany(targets).then(matches => {
      if (!cancelled) setReferenceEntries(current => ({ ...current, ...Object.fromEntries(targets.map((target, index) => [target, matches[index]])) }));
    }).catch(() => { /* 译名暂不可用时保留原文，点击引用仍可重试。 */ });
    return () => { cancelled = true; };
  }, [entry]);

  function lookupMany(targets: string[]) {
    const missing = [...new Set(targets)].filter(target => !requests.current.has(target));
    for (const batch of promptDictionaryBatches(missing)) {
      const request = (async () => {
        const response = await fetch("/api/prompt-dictionary/matches", {
          method: "POST", signal: controller.current?.signal,
          headers: { accept: "application/json", "content-type": "application/json" }, body: JSON.stringify({ scope, prompts: batch }),
        });
        if (!response.ok) throw new Error("词条读取失败，请重试。");
        const payload = await response.json() as { available?: boolean; matches?: PromptDictionaryMatch[] };
        if (payload.available === false || payload.matches?.length !== batch.length) throw new Error("词库暂时不可用，请重试。");
        return payload.matches;
      })();
      batch.forEach((target, index) => {
        const promise = request.then(matches => matches[index]);
        requests.current.set(target, promise);
        void promise.catch(() => { if (requests.current.get(target) === promise) requests.current.delete(target); });
      });
    }
    return Promise.all(targets.map(target => requests.current.get(target)!));
  }

  async function navigate(target: string) {
    const id = ++serial.current;
    setMenu(null); setLoading(true); setNotice("");
    try {
      const [next] = await lookupMany([target]);
      if (serial.current !== id) return;
      const scroll = contentRef.current?.scrollTop ?? 0;
      setPages(current => [...current.slice(0, -1), { ...current[current.length - 1], scroll }, { entry: next, scroll: 0 }]);
    } catch (error) {
      if (serial.current === id) setNotice(error instanceof Error ? error.message : "词条读取失败，请重试。");
    } finally { if (serial.current === id) setLoading(false); }
  }

  function closeMenu() { serial.current++; setMenu(null); }
  function openCurrentMenu(point: { clientX: number; clientY: number }) {
    if (entry.matched === undefined || entry.allowed === undefined) { void openMenu(point, sourceTag, true); return; }
    serial.current++;
    setLoading(false); setNotice("");
    setMenu({ x: point.clientX, y: point.clientY, target: sourceTag, entry, current: true });
  }
  async function openMenu(point: { clientX: number; clientY: number }, target: string, current = false) {
    const id = ++serial.current;
    const pending = { x: point.clientX, y: point.clientY, target, current };
    setLoading(false); setNotice(""); setMenu(pending);
    try {
      const [result] = await lookupMany([target]);
      if (serial.current === id) setMenu(current => current ? { ...pending, entry: result } : null);
    } catch {
      if (serial.current === id) setMenu(current => current ? { ...pending, error: "词条读取失败，可重新打开菜单重试" } : null);
    }
  }

  function description(text: string) {
    const nodes: ReactNode[] = [];
    let end = 0;
    for (const reference of references(text)) {
      nodes.push(text.slice(end, reference.index));
      const { target, label } = reference;
      nodes.push(<a className="prompt-dictionary-reference" key={reference.index} href={wikiUrl(target)} data-long-press-context-menu
        onClick={event => { event.preventDefault(); void navigate(target); }}
        onPointerDown={event => longPress.start(event, point => { void openMenu(point, target); })}
        onContextMenu={event => { event.preventDefault(); event.stopPropagation(); void openMenu(event, target); }}>
        {referenceLabel(target, referenceEntries[target], label)}</a>);
      end = reference.index + reference.text.length;
    }
    nodes.push(text.slice(end));
    return nodes;
  }

  function useEntry(action: DictionaryEditAction, target: PromptDictionaryMatch) {
    if (!actions?.onUse(action, target)) { setNotice("原词条已变化，请关闭说明后重新打开。"); return; }
    onClose();
  }
  const menuItems: NavigationMenuItem[] = menu ? [
    ...(!menu.current ? [{ id: "view", label: "查看词条说明", onSelect: () => { void navigate(menu.target); } }] : []),
    ...(!menu.entry ? [{ id: "loading", label: menu.error || "正在读取词条…", disabled: true, onSelect: () => {} }] : []),
    ...(actions && menu.entry?.matched && menu.entry.allowed && menu.entry.source_text ? [
      { id: "replace", label: `替换「${actions.sourceLabel}」`, onSelect: () => useEntry("replace", menu.entry!) },
      { id: "insert", label: "紧随原词条后加入", onSelect: () => useEntry("insert", menu.entry!) },
      ...(actions.canAddNegative ? [{ id: "negative", label: "加入负向词条", onSelect: () => useEntry("negative", menu.entry!) }] : []),
    ] : []),
    ...(menu.entry && (!menu.entry.matched || !menu.entry.allowed) ? [{ id: "unavailable", label: menu.entry.matched ? "此词条不适用于当前编辑范围" : "本地词库未收录此引用", disabled: true, onSelect: () => {} }] : []),
  ] : [];
  const chips = (values: string[] | undefined) => values?.length ? <span className="prompt-dictionary-detail-chips">{values.map(value => <span key={value}>{value}</span>)}</span> : <span className="prompt-dictionary-detail-empty">暂无</span>;
  return createPortal(<dialog className="prompt-dictionary-details" ref={dialogRef} aria-label={entry.display_text || entry.prompt_text} {...longPress.captureProps}
    onCancel={event => { event.preventDefault(); if (menu) closeMenu(); else onClose(); }}
    onKeyDown={event => { event.stopPropagation(); if (event.key === "Escape" && menu) { event.preventDefault(); closeMenu(); } }}
    onClick={event => { if (event.target === event.currentTarget) onClose(); }}>
    <header className="prompt-dictionary-details-header">
      {pages.length > 1 && <button type="button" aria-label="返回上一词条" onClick={() => { serial.current++; setMenu(null); setLoading(false); setNotice(""); setPages(current => current.slice(0, -1)); }}>←</button>}
      <div><div className="prompt-dictionary-details-title" data-long-press-context-menu={actions ? true : undefined}
        onPointerDown={event => { if (actions) longPress.start(event, openCurrentMenu); }}
        onContextMenu={event => { if (actions) { event.preventDefault(); event.stopPropagation(); openCurrentMenu(event); } }}>
        <h2>{entry.display_text || entry.prompt_text}</h2>
        {actions && <button type="button" className="prompt-dictionary-details-actions" aria-label="当前词条操作" aria-haspopup="menu" aria-expanded={Boolean(menu?.current)} title="当前词条操作（右键或长按标题也可打开）"
          onClick={event => { const rect = event.currentTarget.getBoundingClientRect(); openCurrentMenu({ clientX: rect.left, clientY: rect.bottom }); }}>⋯</button>}
      </div><code>{sourceTag}</code></div>
      <button type="button" onClick={onClose} aria-label="关闭词条说明">×</button>
    </header>
    <div className="prompt-dictionary-details-content" ref={contentRef}>
      {loading && <p role="status">正在读取词条…</p>}
      {notice && <p role="alert">{notice}</p>}
      {entry.matched === false && <p className="prompt-dictionary-detail-empty">本地词库未收录此引用，可通过下方来源查看原文。</p>}
      <dl className="prompt-dictionary-detail-facts">
        <dt>使用频率</dt><dd>{frequency ? `${frequency.label} · ${entry.post_count!.toLocaleString("zh-CN")} 次使用` : "暂无数据"}</dd>
        <dt>标签类型</dt><dd>{providerLabels[entry.provider_type ?? ""] ?? "暂无"}</dd>
        <dt>分类</dt><dd>{chips(entry.categories?.map(id => dictionaryCategoryLabels[id] ?? id))}</dd>
        <dt>关键词</dt><dd>{chips(entry.keywords)}</dd>
        <dt>标签别名</dt><dd>{chips(entry.aliases)}</dd>
        <dt>其他名称</dt><dd>{chips(entry.other_names)}</dd>
        <dt>来源</dt><dd><a href={wikiUrl(sourceTag)} target="_blank" rel="noreferrer">Danbooru Wiki ↗</a></dd>
      </dl>
      {entry.description_language === "zh" && entry.description && <section className="prompt-dictionary-description-section">
        <h3>中文说明</h3><div className="prompt-dictionary-description-body">{description(entry.description)}</div>
      </section>}
      <section className="prompt-dictionary-description-section prompt-dictionary-original-section">
        <h3>原文说明</h3>{entry.original_description ? <div className="prompt-dictionary-description-body" lang="en">{description(entry.original_description)}</div> : <p className="prompt-dictionary-detail-empty">暂无原文说明。</p>}
      </section>
    </div>
    {menu && <NavigationContextMenu request={{ x: menu.x, y: menu.y, label: referenceLabel(menu.target, menu.entry || referenceEntries[menu.target]), items: menuItems }} onClose={() => setMenu(null)} />}
  </dialog>, document.body);
}
