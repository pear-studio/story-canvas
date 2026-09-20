import { useLayoutEffect, useRef, type HTMLAttributes, type RefObject } from "react";
import { promptTagSpans } from "../shared/prompt-tags.mjs";
import type { PromptDictionaryMatch } from "./prompt-display";

export type InlinePromptHandle = { setSelectionRange: (start: number, end: number) => void };

// 注释没有原文长度；所有选区、复制和编辑都使用剔除注释后的字符位置。
function rawText(node: Node): string {
  if (node instanceof Element && (node.hasAttribute("data-prompt-note") || node.hasAttribute("data-prompt-tail"))) return "";
  if (node.nodeType === Node.TEXT_NODE) return node.textContent ?? "";
  if (node instanceof HTMLBRElement) return "\n";
  return [...node.childNodes].map(rawText).join("");
}

function selectionOffsets(root: HTMLElement) {
  const selection = window.getSelection();
  if (!selection?.anchorNode || !root.contains(selection.anchorNode) || !selection.focusNode || !root.contains(selection.focusNode)) return null;
  const offset = (node: Node, position: number) => {
    const range = document.createRange();
    range.selectNodeContents(root);
    range.setEnd(node, position);
    return rawText(range.cloneContents()).length;
  };
  return [offset(selection.anchorNode, selection.anchorOffset), offset(selection.focusNode, selection.focusOffset)] as const;
}

function restoreSelection(root: HTMLElement, anchor: number, focus: number) {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: node => node.parentElement?.closest("[data-prompt-note]") ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT });
  const nodes: Node[] = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  if (!nodes.length) { const node = document.createTextNode(""); root.append(node); nodes.push(node); }
  const point = (offset: number): [Node, number] => {
    for (const node of nodes) { const length = node.textContent?.length ?? 0; if (offset <= length) return [node, offset]; offset -= length; }
    const last = nodes[nodes.length - 1]; return [last, last.textContent?.length ?? 0];
  };
  window.getSelection()?.setBaseAndExtent(...point(anchor), ...point(focus));
}

type Props = Omit<HTMLAttributes<HTMLDivElement>, "onChange" | "onSelect"> & {
  value: string; matches: Record<string, PromptDictionaryMatch>; readOnly?: boolean;
  inputRef?: RefObject<InlinePromptHandle | null>;
  onValueChange?: (value: string, caret: number) => void;
  onCaretChange?: (caret: number) => void;
  onDetails: (entry: PromptDictionaryMatch) => void;
};

export function InlinePromptInput({ value, matches, readOnly, inputRef, onValueChange, onCaretChange, onDetails, ...props }: Props) {
  const rootRef = useRef<HTMLDivElement>(null);
  const composing = useRef(false);
  const latest = useRef({ value, matches, onValueChange, onCaretChange, onDetails });
  latest.current = { value, matches, onValueChange, onCaretChange, onDetails };
  const pendingSelection = useRef<readonly [number, number] | null>(null);
  const render = () => {
    const root = rootRef.current!;
    if (composing.current) return;
    const selected = pendingSelection.current ?? (document.activeElement === root ? selectionOffsets(root) : null);
    pendingSelection.current = null;
    const { value: text, matches: dictionary } = latest.current;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const span of promptTagSpans(text)) {
      const entry = dictionary[span.tag];
      if (!entry?.matched) continue;
      fragment.append(document.createTextNode(text.slice(cursor, span.start)));
      const mark = document.createElement("mark");
      mark.textContent = text.slice(span.start, span.end);
      fragment.append(mark);
      if (entry.source_text) {
        const note = document.createElement("button");
        note.type = "button"; note.contentEditable = "false";
        note.dataset.promptNote = ""; note.tabIndex = -1;
        note.textContent = `${entry.display_text || entry.prompt_text} ⓘ`;
        note.setAttribute("aria-label", `查看 ${entry.display_text || entry.prompt_text} 的词条说明`);
        note.setAttribute("aria-haspopup", "dialog");
        note.onpointerdown = event => event.preventDefault();
        note.onclick = () => latest.current.onDetails(entry);
        fragment.append(note);
      }
      cursor = span.end;
    }
    fragment.append(document.createTextNode(text.slice(cursor)));
    if (!text || text.endsWith("\n")) {
      const tail = document.createElement("br");
      tail.dataset.promptTail = "";
      fragment.append(tail);
    }
    root.replaceChildren(fragment);
    if (selected) restoreSelection(root, selected[0], selected[1]);
  };
  useLayoutEffect(render, [value, matches]);
  useLayoutEffect(() => {
    if (inputRef) inputRef.current = { setSelectionRange: (start, end) => { rootRef.current?.focus({ preventScroll: true }); restoreSelection(rootRef.current!, start, end); latest.current.onCaretChange?.(start); } };
    const changed = () => { const selected = selectionOffsets(rootRef.current!); if (selected) latest.current.onCaretChange?.(Math.min(...selected)); };
    document.addEventListener("selectionchange", changed);
    return () => { document.removeEventListener("selectionchange", changed); if (inputRef) inputRef.current = null; };
  }, [inputRef]);
  const replace = (text: string, start?: number, end?: number) => {
    const selected = selectionOffsets(rootRef.current!) ?? [value.length, value.length];
    start ??= Math.min(...selected); end ??= Math.max(...selected);
    const next = value.slice(0, start) + text + value.slice(end);
    const caret = start + text.length;
    pendingSelection.current = [caret, caret];
    latest.current.value = next;
    onValueChange?.(next, caret);
    render();
  };
  return <div {...props} ref={rootRef} className={`prompt-inline-input ${props.className ?? ""}`} contentEditable={!readOnly} suppressContentEditableWarning aria-readonly={readOnly || undefined} aria-multiline="true"
    onCompositionStart={event => { composing.current = true; props.onCompositionStart?.(event); }}
    onCompositionEnd={event => {
      composing.current = false;
      const text = rawText(event.currentTarget);
      const selected = selectionOffsets(event.currentTarget);
      // 父组件先退出合成状态，随后才能将最终文本标记为待编辑草稿。
      props.onCompositionEnd?.(event);
      latest.current.value = text;
      onValueChange?.(text, selected?.[1] ?? text.length);
      render();
    }}
    onInput={event => { const text = rawText(event.currentTarget); const selected = selectionOffsets(event.currentTarget); latest.current.value = text; onValueChange?.(text, selected?.[1] ?? text.length); if (!composing.current) render(); }}
    onKeyDown={event => {
      props.onKeyDown?.(event);
      if (event.defaultPrevented || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || composing.current || readOnly) return;
      const selected = selectionOffsets(event.currentTarget); if (!selected) return;
      const start = Math.min(...selected), end = Math.max(...selected);
      if (event.key === "ArrowLeft" || event.key === "ArrowRight") {
        if (event.ctrlKey || event.metaKey || event.altKey) return;
        event.preventDefault();
        const direction = event.key === "ArrowLeft" ? -1 : 1;
        const focus = selected[1];
        const step = direction < 0 ? [...value.slice(0, focus)].at(-1)?.length ?? 0 : [...value.slice(focus)][0]?.length ?? 0;
        const next = !event.shiftKey && start !== end ? direction < 0 ? start : end : focus + direction * step;
        restoreSelection(event.currentTarget, event.shiftKey ? selected[0] : next, next); return;
      }
      if (event.key === "{" && start !== end && !event.ctrlKey && !event.metaKey) {
        event.preventDefault();
        replace(`{${value.slice(start, end)}}`, start, end);
      } else if (event.key === "Backspace" || event.key === "Delete") {
        event.preventDefault();
        const backward = event.key === "Backspace";
        const chunk = backward ? value.slice(0, start) : value.slice(end);
        const count = event.ctrlKey || event.metaKey ? (backward ? chunk.match(/\s*\S+\s*$/)?.[0].length : chunk.match(/^\s*\S+\s*/)?.[0].length) ?? 0 : (backward ? [...chunk].at(-1)?.length : [...chunk][0]?.length) ?? 0;
        replace("", start === end && backward ? start - count : start, start === end && !backward ? end + count : end);
      } else if (event.key === "Enter") { event.preventDefault(); replace("\n"); }
    }}
    onCopy={event => { const selected = selectionOffsets(event.currentTarget); if (selected) { event.preventDefault(); event.clipboardData.setData("text/plain", value.slice(Math.min(...selected), Math.max(...selected))); } }}
    onCut={event => { const selected = selectionOffsets(event.currentTarget); if (selected) { event.preventDefault(); event.clipboardData.setData("text/plain", value.slice(Math.min(...selected), Math.max(...selected))); if (!readOnly) replace(""); } }}
    onPaste={event => { event.preventDefault(); if (!readOnly) replace(event.clipboardData.getData("text/plain").replace(/\r\n?/g, "\n")); }}
    onDrop={event => event.preventDefault()}
  />;
}
