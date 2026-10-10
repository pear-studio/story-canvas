import type { TextPageLayout } from "../shared/text-page-layout.mjs";
import type {LetteringLocale} from './page-translations';
import { createRoot } from "react-dom/client";
import { flushSync } from "react-dom";
import { WorkbenchLetteringOverlay } from "./WorkbenchPageEditor";
import { TextPageArtwork } from "./TextPageArtwork";
import { previewLetteringItems, type DialogueLine, type LetteringItem, type LetteringSettings } from "./lettering";
import type { WorkbenchCharacter } from "./project-workbench-client";
import "./styles.css";

export type FinishedLettering = {locale?:LetteringLocale;source_dialogue?:DialogueLine[]} & ({
  page_kind: "text"; display_title: string; body: string; text_layout: TextPageLayout;
  settings: Pick<LetteringSettings, "font_family">; canvas: string;
} | {
  page_kind?: never; dialogue: DialogueLine[]; items: LetteringItem[]; settings: LetteringSettings; canvas: string;
});
declare global { interface Window { renderFinishedLettering: (value: FinishedLettering,inspect?:boolean) => Promise<{blockers:string[];warnings:string[];objects:Array<{id:string;box:{x:number;y:number;w:number;h:number};issues:string[];budget_exceeded:boolean}>}> } }
const root = createRoot(document.getElementById("root")!);
window.renderFinishedLettering = async (value,inspect=false) => {
  document.body.style.cssText = "margin:0;background:transparent;overflow:hidden";
  document.documentElement.style.background = "transparent";
  document.getElementById("root")!.style.cssText = "position:fixed;inset:0";
  const text=value.page_kind==='text'?value.display_title+value.body:value.dialogue.map(line=>line.text).join('');
  await document.fonts.load(`28px "${value.settings.font_family.replaceAll('"', '')}"`,text);
  if (value.page_kind === "text") {
    flushSync(() => root.render(<TextPageArtwork locale={value.locale} title={value.display_title ?? ""} body={value.body ?? ""} layout={value.text_layout} style={value.settings} />));
    await document.fonts.ready;
    for(let frame=0;frame<8;frame++)await new Promise<void>(resolve=>requestAnimationFrame(()=>resolve()));
    const blockers=document.querySelector(".text-page-artwork")?.getAttribute("data-overflow") === "true"?['文字超出画布，请缩小字号或减少内容后再输出。']:[];
    if(!inspect&&blockers.length)throw new Error(blockers[0]);
    return {blockers,warnings:[],objects:[]};
  }
  await document.fonts.load("100px SVHeart");
  const characters = Object.entries(value.settings.character_colors).map(([id, display_color]) => ({ id, name: id, style: { display_color } })) as WorkbenchCharacter[];
  flushSync(() => root.render(<WorkbenchLetteringOverlay locale={value.locale} sourceDialogue={value.source_dialogue} dialogue={value.dialogue} items={previewLetteringItems(value.source_dialogue??value.dialogue, value.items, value.settings)} characters={characters} style={value.settings} canvas={value.canvas} />));
  await document.fonts.ready;
  await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
  const frame=document.querySelector('.lettering-overlay')!.getBoundingClientRect();
  const objects=Array.from(document.querySelectorAll<HTMLElement>('[data-dialogue-id]')).map(node=>{const rect=node.getBoundingClientRect();return {id:node.dataset.dialogueId!,box:{x:(rect.x-frame.x)/frame.width,y:(rect.y-frame.y)/frame.height,w:rect.width/frame.width,h:rect.height/frame.height},issues:(node.dataset.letteringIssues??'').split(',').filter(Boolean),budget_exceeded:node.dataset.translationBudget==='exceeded'};});
  const blockers=objects.filter(object=>object.issues.some(issue=>['outside','overflow'].includes(issue))).map(object=>`${object.id}：嵌字超出画布或发生裁切`);
  const narration=document.querySelector('.narration-bar')?.getBoundingClientRect();if(narration&&(narration.top<frame.top-1||narration.bottom>frame.bottom+1))blockers.push('旁白超出画布');
  const warnings=objects.filter(object=>object.budget_exceeded).map(object=>`${object.id}：超过中文占用空间建议值，可缩短译文`);
  if(!inspect&&value.locale&&value.locale!=='zh'&&blockers.length)throw new Error(blockers.join('；'));
  return {blockers,warnings,objects};
};
