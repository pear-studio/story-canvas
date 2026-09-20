export type SelectedPageGenerationReadiness = {
  compiledReady: boolean;
  loraAvailable: boolean | null;
};

type PageWorkspaceTab = "visual" | "prompt" | "review" | "lettering";
type CharacterFactState = "saved" | "pending" | "saving" | "error";
type StrictPromptContextDemand =
  | { surface: "page-workspace"; activeTab: PageWorkspaceTab }
  | { surface: "character-editor"; factState: CharacterFactState };

export function strictPromptContextRequested(demand: StrictPromptContextDemand) {
  if (demand.surface === "page-workspace") return demand.activeTab === "prompt";
  return demand.factState === "saved";
}

/**
 * workbench summary 不诊断未打开页面的 LoRA，因此 null 表示“尚未检查”，不是“不可用”。
 * 只有详情明确返回 false 才在浏览器侧阻止；生成接口仍会对全部选中页面做最终校验。
 */
export function selectedPagesGenerationReady(profileAvailable: boolean, pages: SelectedPageGenerationReadiness[]) {
  return profileAvailable && pages.length > 0 && pages.every((page) => page.compiledReady && page.loraAvailable !== false);
}
