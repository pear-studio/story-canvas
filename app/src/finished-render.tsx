import type { TextPageLayout } from "../shared/text-page-layout.mjs";
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { WorkbenchLetteringOverlay } from "./WorkbenchPageEditor";
import { TextPageArtwork } from "./TextPageArtwork";
import { previewLetteringItems, type DialogueLine, type LetteringItem, type LetteringSettings } from "./lettering";
import type { WorkbenchCharacter } from "./project-workbench-client";
import "./styles.css";

export type FinishedLettering = {
  page_kind: "text"; display_title: string; body: string; text_layout: TextPageLayout;
  settings: Pick<LetteringSettings, "font_family">; canvas: string;
} | {
  page_kind?: never; dialogue: DialogueLine[]; items: LetteringItem[]; settings: LetteringSettings; canvas: string;
};
declare global { interface Window { renderFinishedLettering: (value: FinishedLettering) => Promise<void> } }
const root = createRoot(document.getElementById("root")!);
window.renderFinishedLettering = async (value) => {
  document.body.style.cssText = "margin:0;background:transparent;overflow:hidden";
  document.documentElement.style.background = "transparent";
  document.getElementById("root")!.style.cssText = "position:fixed;inset:0";
  await document.fonts.load(`28px "${value.settings.font_family.replaceAll('"', '')}"`);
  if (value.page_kind === "text") {
    flushSync(() => root.render(<TextPageArtwork title={value.display_title ?? ""} body={value.body ?? ""} layout={value.text_layout} style={value.settings} />));
    await document.fonts.ready;
    await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
    if (document.querySelector(".text-page-artwork")?.getAttribute("data-overflow") === "true") throw new Error("文字超出画布，请缩小字号或减少内容后再输出。");
    return;
  }
  await document.fonts.load("100px SVHeart");
  const characters = Object.entries(value.settings.character_colors).map(([id, display_color]) => ({ id, name: id, style: { display_color } })) as WorkbenchCharacter[];
  flushSync(() => root.render(<WorkbenchLetteringOverlay dialogue={value.dialogue} items={previewLetteringItems(value.dialogue, value.items, value.settings)} characters={characters} style={value.settings} canvas={value.canvas} />));
  await document.fonts.ready;
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
};
