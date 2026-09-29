import type { ReferenceEntry } from "./ReferenceLibrary";
import type { TextPageLayout } from "../shared/text-page-layout.mjs";
import type { PageKey } from "./page-key";
import { workbenchResponseJson } from "./api-response";
import {
  mutateDerived,
  mutateFacts,
  mutateTargetFacts,
  PROJECT_REVISION_HEADER,
  readFacts,
} from "./project-write-client";
import type { LetteringItem, LetteringSettings } from "./lettering";
import type { WorkbenchScope } from '../shared/workbench-scope.mjs';
export type { WorkbenchScope } from '../shared/workbench-scope.mjs';

export const characterSource = (id: string, variant: string) => `character:${id}:${variant}`;
export const sceneSource = (id: string, variant: string) => `scene:${id}:${variant}`;

export type SettingKind = 'character' | 'scene';
export type PromptModelId = 'anima' | 'qwen';
export type PromptSourceVersions = Record<string, string>;
export type Scene = WorkbenchCharacter;
export type PageOwner = { page_id: string; owner_kind: 'story' | 'character' | 'scene'; sequence_id?: string; character_id?: string; scene_id?: string; variant_id?: string };
export type PageReferenceEntry = ReferenceEntry & { purpose?: string };
export type PagePrompt = {
  lora_overrides?: import("../shared/lora-inheritance.mjs").LoraOverrides;
  loras?: Array<{filename:string;sha256:string;weight:number;trigger?:string;enabled?:boolean}>;
  trigger_sources?: {style:string[];characters:Record<string,string[]>;scenes:Record<string,string[]>};
  text?: string;
  composition?: 'settings' | 'standalone';
  population?: import('./models/anima/types').PromptFragment[];
  person?: import('./models/anima/types').PromptFragment[];
  setting?: import('./models/anima/types').PromptFragment[];
  camera?: import('./models/anima/types').PromptFragment[];
  avoid?: import('./models/anima/types').PromptFragment[];
  inheritance?: Record<string, import('./models/anima/types').InheritedAdjustments>;
  scene_id?: string;
  scene_variant_id?: string;
  text_overrides?: Record<string, string>;
  reference_overrides?: Record<string, string[]>;
  reference_images?: PageReferenceEntry[];
};
export type CharacterPromptVariant = {
  text: string;
  reference_images?: ReferenceEntry[];
};
export type CharacterPromptDocument = {
  prompt_name: string;
  /** 键为子设定 ID，与 visual.variants 一一对应；无保留 id。 */
  variants: Record<string, CharacterPromptVariant>;
};
export type Candidate = {
  candidate_id: string;
  file: string;
  url: string;
  task_id: string;
  seed: number | null;
  generated_at: string | null;
  generation_signature: string | null;
};
export type PageMedia = {
  candidates: Candidate[];
};
export type TextSourceEntry = {
  source_file: string;
  offset: number;
  original_sentence: string;
};
export type TextSourceContext = {
  source_file: string;
  offset: number;
  hit_line: number;
  lines: Array<{ number: number; text: string; hit: boolean }>;
};
export type WorkbenchPage = {
  project_loras?: PagePrompt['loras'];
  model_id?: 'anima' | 'qwen';
  render?: {version:1;model_id:'anima'|'qwen';profile_id:string;canvas:string};
  render_sha256?: string;
  model_prompts?: {models?:Record<string,PagePrompt>};
  render_capabilities?: ProjectWorkbenchView['render_capabilities'];
  kind: "story" | "character" | "scene";
  owner?: PageOwner;
  character_id?: string;
  scene_id?: string;
  sequence_id?: string;
  diagnostics?: string[];
  page_id: string;
  page_key: PageKey;
  title: string;
  visual_goal?: string;
  scene_description?: string;
  content_sha256?: string;
  prompt?: PagePrompt;
  prompt_sha256?: string;
  prompt_context_sha256?: string | null;
  characters?: Array<{ character_id: string; variant_id: string }>;
  dialogue?: Array<{ id: string; mode: "narration" | "speech" | "thought" | "heart"; speaker?: string; text: string; position?: "top" | "bottom" }>;
  page_kind?: "text" | null;
  body?: string;
  display_title?: string;
  text_layout?: TextPageLayout;

  lettering?: { page: string; items: LetteringItem[] };
  layout_sha256?: string;
  variant_id?: string | null;
};
export type WorkbenchCharacter<TPrompt = CharacterPromptDocument> = {
  model_id?: 'anima'|'qwen';
  prompt_source_versions?: Partial<Record<PromptModelId, Record<string, string>>>;
  prompt_scope_versions?: Partial<Record<PromptModelId, {base: string; variants: Record<string, string>}>>;
  model_prompts?: {models?: {anima?:import('./models/anima/types').CharacterPromptDocument;qwen?:CharacterPromptDocument}};
  id: string;
  name: string;
  description?: string;
  profile_sha256?: string;
  visual: { description?: string; variants: Array<{ id: string; name: string; description?: string }> };
  visual_sha256?: string;
  prompt?: TPrompt;
  prompt_sha256?: string;
  style: { display_color: string } | null;
  pages: WorkbenchPage[];
};
export type ProjectWorkbenchView = {
  scope?: WorkbenchScope;
  scenes?: { scenes: Scene[] };
  scenes_sha256?: string;
  pages?: WorkbenchPage[];
  orphan_pages?: WorkbenchPage[];
  version: 6;
  project: { id: string; title: string; canvas: string | null; default_render_profile: string | null; lettering_settings: LetteringSettings | null; lettering_settings_sha256: string | null };
  outline: {
    synopsis: string;
    synopsis_sha256: string;
    chapters: Array<{ id: string; title: string; summary: string; summary_sha256: string; sequences: Array<{ id: string; title: string; summary: string; summary_sha256: string; pages: WorkbenchPage[] }> }>;
  };
  characters: WorkbenchCharacter[];
  render_capabilities?: {
    text_page?: { dimensions: { width: number; height: number } | null; error: string | null };
    candidates: { available: boolean; counts: number[]; blocker?: string; details?: string[] };
  };
  diagnostics: Array<{ code: string; [key: string]: unknown }>;
};

export type EditableWorkbenchPage = WorkbenchPage & Required<Pick<WorkbenchPage, 'prompt' | 'prompt_sha256' | 'content_sha256'>>;
export type EditableWorkbenchCharacter<TPrompt = CharacterPromptDocument> = WorkbenchCharacter<TPrompt> & Required<Pick<WorkbenchCharacter<TPrompt>, 'prompt' | 'prompt_sha256' | 'profile_sha256' | 'visual_sha256' | 'description'>>;
export function isEditablePage(page: WorkbenchPage): page is EditableWorkbenchPage {
  return Boolean(page.prompt && page.prompt_sha256 && page.content_sha256);
}
export function isEditableSetting(setting: WorkbenchCharacter): setting is EditableWorkbenchCharacter {
  return Boolean(setting.prompt && setting.prompt_sha256 && setting.profile_sha256 && setting.visual_sha256 && typeof setting.description === 'string');
}

function base(projectId: string) {
  return `/api/projects/${encodeURIComponent(projectId)}/workbench`;
}

export async function runNavigationAction(projectId: string, action: string, value: Record<string, unknown> = {}) {
  return workbenchResponseJson<Record<string, unknown>>(await mutateFacts(`${base(projectId)}/navigation/${encodeURIComponent(action)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(value),
  }));
}

export async function loadProjectWorkbench(projectId: string, signal?: AbortSignal, scope: WorkbenchScope = { kind: 'directory' }, requestId?: string) {
  const response = await readFacts(`${base(projectId)}?scope=${encodeURIComponent(JSON.stringify(scope))}`, { headers: { accept: "application/json", ...(requestId ? {'x-story-canvas-request-id': requestId} : {}) }, signal });
  const view = await workbenchResponseJson<ProjectWorkbenchView>(response);
  const revision = response.headers.get(PROJECT_REVISION_HEADER);
  if (!revision) throw new Error("工作台响应缺少项目 revision");
  return { view, revision };
}

export async function loadProjectRevision(projectId: string, signal?: AbortSignal) {
  return workbenchResponseJson<{ revision: string }>(await readFacts(`/api/projects/${encodeURIComponent(projectId)}/revision`, { cache: "no-store", signal }));
}

export async function loadWorkbenchSetting(projectId: string, kind: SettingKind, id: string, signal?: AbortSignal) {
  return workbenchResponseJson<Omit<WorkbenchCharacter, 'pages' | 'style'>>(await readFacts(`${base(projectId)}/setting-detail?kind=${kind}&id=${encodeURIComponent(id)}`, {signal}));
}

export async function loadPageMedia(
  projectId: string,
  pageKey: WorkbenchPage["page_key"],
  signal?: AbortSignal,
  knownRevision?: string,
  fresh = false,
) {
  const result = await workbenchResponseJson<{ unchanged?: false; version: 1; revision: string; page_key: WorkbenchPage["page_key"]; media: PageMedia } | { unchanged: true; revision: string }>(await readFacts(`${base(projectId)}/page-media`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(knownRevision ? { "x-story-canvas-media-revision": knownRevision } : {}), ...(fresh ? { "x-story-canvas-media-fresh": "1" } : {}) },
    body: JSON.stringify({ page_key: pageKey }),
    signal,
  }));
  return result.unchanged ? null : result;
}

export async function savePagePrompt(projectId: string, page: WorkbenchPage, prompt: PagePrompt) {
  return workbenchResponseJson<{ kind: WorkbenchPage["kind"]; page_id: string; prompt: PagePrompt; prompt_sha256: string; audit?: import("./prompt-audit-display").PromptAuditReport }>(await mutateTargetFacts(`${base(projectId)}/page-prompt`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: page.kind, page_id: page.page_id, prompt, expected_sha256: page.prompt_sha256, expected_context_sha256: page.prompt_context_sha256 }),
  }));
}

export async function saveCharacterPrompt<TPrompt extends object>(projectId: string, character: WorkbenchCharacter<TPrompt>, prompt: TPrompt, kind: SettingKind = "character") {
  const document = character.model_prompts?.models ? {models:{...character.model_prompts.models,[character.model_id ?? 'qwen']:prompt}} : prompt;
  const result = await workbenchResponseJson<{ character_id: string; prompt: TPrompt & {models?: Record<string,TPrompt>}; prompt_sha256: string; downstream_diagnostics?: Array<{ code: string }> }>(await mutateTargetFacts(`${base(projectId)}/${kind}-prompt`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      [`${kind}_id`]: character.id,
      prompt: document,
      expected_sha256: character.prompt_sha256,
      expected_visual_sha256: character.visual_sha256,
    }),
  }));
  return {...result, model_prompts: result.prompt.models ? result.prompt as WorkbenchCharacter['model_prompts'] : undefined, prompt: result.prompt.models?.[character.model_id ?? 'qwen'] ?? result.prompt};
}

export type CharacterProfileDraft = Pick<WorkbenchCharacter, "name" | "description">;
export type CharacterVisualDraft = WorkbenchCharacter["visual"];

export async function saveCharacterProfile(projectId: string, character: WorkbenchCharacter<unknown>, profile: CharacterProfileDraft, kind: SettingKind = "character") {
  return workbenchResponseJson<{
    character_id: string;
    profile: CharacterProfileDraft;
    profile_sha256: string;
  }>(await mutateTargetFacts(`${base(projectId)}/${kind}-profile`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ [`${kind}_id`]: character.id, profile, expected_sha256: character.profile_sha256 }),
  }));
}

export async function saveCharacterVisual(projectId: string, character: WorkbenchCharacter<unknown>, visual: CharacterVisualDraft, kind: SettingKind = "character") {
  return workbenchResponseJson<{
    character_id: string;
    visual: CharacterVisualDraft;
    visual_sha256: string;
  }>(await mutateTargetFacts(`${base(projectId)}/${kind}-visual`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ [`${kind}_id`]: character.id, visual, expected_sha256: character.visual_sha256 }),
  }));
}

export async function renameCharacterVariant<TPrompt extends object>(projectId: string, character: WorkbenchCharacter<TPrompt>, oldId: string, newId: string, kind: SettingKind = "character") {
  const result = await workbenchResponseJson<{
    character_id: string;
    visual: CharacterVisualDraft;
    visual_sha256: string;
    prompt: TPrompt & {models?:Record<string,TPrompt>};
    prompt_sha256: string;
  }>(await mutateFacts(`${base(projectId)}/${kind}-variant-rename`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      [`${kind}_id`]: character.id,
      old_id: oldId,
      new_id: newId,
      expected_sha256: character.visual_sha256,
      expected_prompt_sha256: character.prompt_sha256,
    }),
  }));
  return {...result, model_prompts: result.prompt.models ? result.prompt as WorkbenchCharacter['model_prompts'] : undefined, prompt: result.prompt.models?.[character.model_id ?? 'qwen'] ?? result.prompt};
}

export type StoryPageContentDraft = {
  title: string;
  scene_description: string;
  characters: Array<{ character_id: string; variant_id: string }>;
  dialogue: Array<{ id?: string; mode: "narration" | "speech" | "thought" | "heart"; speaker?: string; text: string; position?: "top" | "bottom" }>;
  page_kind?: "text" | null;
  body?: string;
  display_title?: string;
  text_layout?: TextPageLayout;

};

export type CharacterPageContentDraft = { title: string; visual_goal?: string };

export type StorySummaryTarget = { kind: "synopsis" } | { kind: "chapter" | "sequence"; id: string };
export type StorySummaryResult = { target: StorySummaryTarget; text: string; sha256: string };

export async function saveStorySummary(projectId: string, target: StorySummaryTarget, text: string, expectedSha256: string) {
  return workbenchResponseJson<StorySummaryResult>(await mutateTargetFacts(`${base(projectId)}/story-summary`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ target, text, expected_sha256: expectedSha256 }),
  }));
}

export async function savePageLettering(projectId: string, page: WorkbenchPage, items: LetteringItem[], expectedSha256?: string) {
  const layoutSha256 = expectedSha256 ?? page.layout_sha256;
  if (!layoutSha256) throw new Error("当前页面缺少嵌字布局版本");
  return workbenchResponseJson<{
    page_key: WorkbenchPage["page_key"];
    lettering: { page: string; items: LetteringItem[] };
    layout_sha256: string;
  }>(await mutateTargetFacts(`${base(projectId)}/page-lettering`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      page_key: page.page_key,
      lettering: { items },
      expected_sha256: layoutSha256,
    }),
  }));
}

export type PageTextSourcesDraft = {
  project_id: string;
  target_id: string;
  document: Record<string, TextSourceEntry>;
  expected_sha256: string;
  expected_context_sha256: string;
};

export async function loadPageTextSources(projectId: string, pageId: string, signal?: AbortSignal) {
  return workbenchResponseJson<PageTextSourcesDraft>(await readFacts(`${base(projectId)}/page-text-sources/${encodeURIComponent(pageId)}`, {
    headers: { accept: "application/json" },
    signal,
  }));
}

export async function deletePageTextSource(
  projectId: string,
  pageId: string,
  dialogueId: string,
  expected: { expected_sha256: string; expected_context_sha256: string },
) {
  return workbenchResponseJson<{
    page_id: string;
    text_sources: Record<string, TextSourceEntry>;
    text_sources_sha256: string;
  }>(await mutateTargetFacts(`${base(projectId)}/page-text-sources/${encodeURIComponent(pageId)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dialogue_id: dialogueId, ...expected }),
  }));
}

export async function loadTextSourceContext(projectId: string, entry: { source_file: string; offset: number }, signal?: AbortSignal) {
  const params = new URLSearchParams({ source_file: entry.source_file, offset: String(entry.offset) });
  return workbenchResponseJson<TextSourceContext>(await readFacts(`${base(projectId)}/text-source-context?${params}`, {
    headers: { accept: "application/json" },
    signal,
  }));
}

export async function startPageRender(
  projectId: string,
  pageKey: WorkbenchPage["page_key"],
  options: { operation: "candidates"; count: number; seed?: number; prompt_source?: PromptSourceChoice },
) {
  return workbenchResponseJson<{
    task: { task_id: string; status: string; operation: "candidates"; page_key: WorkbenchPage["page_key"]; count: number };
  }>(await mutateDerived(`${base(projectId)}/render`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page_key: pageKey, ...options }),
  }));
}

export type StoryCandidateRefreshPage = {
  page_key: PageKey;
  status: "ready" | "active" | "unavailable";
  signature: string | null;
  matched: number;
  candidate_ids: string[];
  all_candidate_ids: string[];
};

export async function inspectStoryCandidates(projectId: string, pageKeys: PageKey[], signal: AbortSignal) {
  return workbenchResponseJson<{ pages: StoryCandidateRefreshPage[] }>(await readFacts(`${base(projectId)}/story-candidate-refresh`, {
    method: "POST", headers: { "content-type": "application/json" }, signal,
    body: JSON.stringify({ action: "inspect", page_keys: pageKeys }),
  }));
}

export type StoryCandidateRefreshOptions = { action: "clean"; scope: "mismatch" | "all" } | { action: "generate"; scope: "missing" | "all"; count: number };

export async function refreshStoryCandidates(projectId: string, options: StoryCandidateRefreshOptions, page: StoryCandidateRefreshPage) {
  return workbenchResponseJson<{ status: "skipped" | "deleted" | "queued"; count?: number }>(await mutateDerived(`${base(projectId)}/story-candidate-refresh`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...options, page_key: page.page_key, expected_signature: page.signature,
      ...(options.action === "clean" ? { candidate_ids: options.scope === "all" ? page.all_candidate_ids : page.candidate_ids } : {}) }),
  }));
}

export type PageRenderInspectionIssue = import("./prompt-audit-display").PromptIssue;

export type PromptSection = {
  kind: "global" | "character" | "scene" | "attachment" | "page" | "reference" | "rewrite";
  source?: string;
  prompt_name?: string;
  text: string;
  image_ids?: string[];
};

export type CompiledPromptImage = { index: number; source: string; id: string; file: string; purpose?: string };

export type GenerationDetails = {
  profile_name: string | null;
  canvas: string | null;
  parameters: {
    dimensions: { width: number | null; height: number | null } | null;
    steps: number | null;
    cfg: number | null;
    sampler: string | null;
    scheduler: string | null;
  } | null;
  models: Array<{ role: string; filename: string }>;
  loras: Array<{
    kind: string;
    owner: string;
    filename: string;
    weight: number | null;
    trigger: string | null;
  }>;
  prompt: {
    positive: string;
    negative: string;
    sections: PromptSection[];
  };
};

export type PageRenderInspection = {
  generation_signature: string | null;
  version: 1;
  page_key: WorkbenchPage["page_key"];
  title: string;
  visual_goal?: string;
  scene_description?: string;
  canvas: string | null;
  ready: boolean;
  prompt: {
    positive: string;
    negative: string;
    sections: PromptSection[];
    images: CompiledPromptImage[];
  };
  characters: Array<{
    character_id: string;
    name: string;
    variant_id: string | null;
    configuration_id: string;
  }>;
  loras: Array<{
    kind: string;
    owner: string;
    filename: string;
    weight: number | null;
    trigger: string | null;
    status: string;
    reason: string | null;
    errors?: string[];
    [key: string]: unknown;
  }>;
  render: {
    profile: {
      id: string;
      name: string;
      architecture_family: string;
      prompt_family?: string;
      base_sha256: string | null;
      effective_sha256: string | null;
    } | null;
    profile_inspection: unknown;
    route: {
      operation: string;
      input_source: string;
      workflow_id: string;
      recipe_source_id: string;
      recipe_instance_id: string;
      [key: string]: unknown;
    } | null;
    recipe: unknown;
    workflow: unknown;
  };
  generation: GenerationDetails;
  audit: import("./prompt-audit-display").PromptAuditReport;
  blockers: PageRenderInspectionIssue[];
  warnings: PageRenderInspectionIssue[];
};

export type PromptSourceChoice = "original" | "rewrite";
export type PageRewriteProgress = {
  phase: 'preparing'|'queued'|'running'|'loading'|'generating'|'saving'|'completed'|'failed';
  started_at: number; elapsed_ms: number; finished_at?: number; tokens?: number; error?: string;
};
export type PageRewriteValue = {
  status: "missing" | "current" | "stale";
  rewrite: null | { rewritten_prompt: string; wh_ratio: string };
  original_prompt: string;
  progress?: PageRewriteProgress | null;
};

export async function loadPageRewriteProgress(projectId: string, pageKey: PageKey, signal?: AbortSignal) {
  const query = new URLSearchParams({ page_key: JSON.stringify(pageKey), progress: '1' });
  return workbenchResponseJson<{ progress: PageRewriteProgress | null }>(await readFacts(`${base(projectId)}/page-rewrite?${query}`, { signal }));
}

export async function loadPageRewrite(projectId: string, pageKey: PageKey, signal?: AbortSignal) {
  const query = new URLSearchParams({ page_key: JSON.stringify(pageKey) });
  return workbenchResponseJson<PageRewriteValue>(await readFacts(`${base(projectId)}/page-rewrite?${query}`, { signal }));
}

export async function runPageRewrite(projectId: string, pageKey: PageKey) {
  return workbenchResponseJson<PageRewriteValue>(await mutateTargetFacts(`${base(projectId)}/page-rewrite`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page_key: pageKey }),
  }));
}

export async function inspectPageRender(
  projectId: string,
  pageKey: WorkbenchPage["page_key"],
  prompt?: PagePrompt,
  promptSource: PromptSourceChoice = "original",
) {
  // 本页待保存附图尚未落盘；编辑检查保留其他已保存素材的严格校验。
  // 保存并生成会在提交后重新检查完整页面，不能将这里的结果直接用于出图。
  const inspectionPrompt = prompt === undefined ? undefined : {
    ...prompt,
    ...(prompt.reference_images ? { reference_images: prompt.reference_images.filter(entry => !entry.draft) } : {}),
  };
  return workbenchResponseJson<{ inspection: PageRenderInspection }>(await readFacts(`${base(projectId)}/page-render-inspection`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page_key: pageKey, prompt_source: promptSource, ...(inspectionPrompt === undefined ? {} : { prompt: inspectionPrompt }) }),
  }));
}

export async function saveLetteringSettings(projectId: string, settings: LetteringSettings, expectedSha256: string) {
  return workbenchResponseJson<{ settings: LetteringSettings; sha256: string }>(await mutateTargetFacts(`${base(projectId)}/lettering-settings`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ settings, expected_sha256: expectedSha256 }),
  }));
}

export type CandidateDetail = {
  candidate_id: string;
  created_at: string | null;
  completed_at: string | null;
  seed: number | null;
  generation: GenerationDetails;
};

export async function loadCandidateDetail(projectId: string, pageKey: WorkbenchPage["page_key"], candidateId: string) {
  return workbenchResponseJson<{ detail: CandidateDetail }>(await mutateDerived(`${base(projectId)}/candidate-detail`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page_key: pageKey, candidate_id: candidateId }),
  }));
}

export async function deleteCandidate(projectId: string, pageKey: WorkbenchPage["page_key"], candidateId: string) {
  return workbenchResponseJson<{
    deleted_candidate_id: string;
    task_id: string;
    page_key: WorkbenchPage["page_key"];
  }>(await mutateDerived(`${base(projectId)}/candidates/${encodeURIComponent(candidateId)}`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page_key: pageKey }),
  }));
}

export async function deleteCandidates(
  projectId: string,
  pageKey: WorkbenchPage["page_key"],
  request: { candidate_ids: string[] } | { generation_mismatch: true; expected_signature?: string },
) {
  return workbenchResponseJson<{
    page_key: WorkbenchPage["page_key"];
    deleted_candidate_ids: string[];
    failed_candidates?: Array<{ candidate_id: string; code: string; message: string }>;
  }>(await mutateDerived(`${base(projectId)}/candidates`, {
    method: "DELETE",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page_key: pageKey, ...request }),
  }));
}

export async function loadCandidateCounts(projectId: string, signal?: AbortSignal, knownRevision?: string) {
  const result = await workbenchResponseJson<{ unchanged?: false; counts: Record<string, number>; revision: string } | { unchanged: true; revision: string }>(await readFacts(`${base(projectId)}/candidate-counts`, {
    headers: knownRevision ? { "x-story-canvas-media-revision": knownRevision } : {},
    signal,
  }));
  return result.unchanged ? null : result;
}

export const saveSettingProfile = (kind: SettingKind, projectId: string, setting: WorkbenchCharacter<unknown>, draft: CharacterProfileDraft) => saveCharacterProfile(projectId, setting, draft, kind);
export const saveSettingVisual = (kind: SettingKind, projectId: string, setting: WorkbenchCharacter<unknown>, draft: CharacterVisualDraft) => saveCharacterVisual(projectId, setting, draft, kind);
export const saveSettingPrompt = <T extends object>(kind: SettingKind, projectId: string, setting: WorkbenchCharacter<T>, draft: T) => saveCharacterPrompt(projectId, setting, draft, kind);
function promptScopeChanges(previous: unknown, next: unknown): unknown {
  if (!next || typeof next !== 'object' || Array.isArray(next)) return next;
  const before = previous && typeof previous === 'object' && !Array.isArray(previous) ? previous as Record<string, unknown> : {};
  const after = next as Record<string, unknown>;
  return Object.fromEntries([...new Set([...Object.keys(before), ...Object.keys(after)])].map(key => [key,
    Object.hasOwn(after, key) ? promptScopeChanges(before[key], after[key]) : null]));
}
export async function saveSettingPromptScope<T extends object>(kind: SettingKind, projectId: string, setting: WorkbenchCharacter<unknown>, scope: {model_id: PromptModelId; scope: 'base' | 'variant'; variant_id?: string}, document: T, expected_sha256: string) {
  const model = (setting.model_prompts?.models?.[scope.model_id] ?? (setting.model_id === scope.model_id ? setting.prompt : {})) as Record<string, unknown>;
  const prior = scope.scope === 'variant' ? (model.variants as Record<string, unknown> | undefined)?.[scope.variant_id!] :
    scope.model_id === 'anima' ? {identity: model.identity} : {prompt_name: model.prompt_name};
  return workbenchResponseJson<{document: T; save: {args: {expected_sha256: string}}}>(await mutateTargetFacts('/api/agent/prompt/save', {
    method: 'POST', headers: {'content-type': 'application/json'},
    body: JSON.stringify({project_id: projectId, target: {kind, id: setting.id, ...scope}, changes: promptScopeChanges(prior, document), expected_sha256}),
  }, projectId));
}
export const renameSettingVariant = <T extends object>(kind: SettingKind, projectId: string, setting: WorkbenchCharacter<T>, oldId: string, newId: string) => renameCharacterVariant(projectId, setting, oldId, newId, kind);

export async function saveWholePage(projectId: string, page: WorkbenchPage, content: StoryPageContentDraft, prompt: PagePrompt, items: LetteringItem[], source_versions?: PromptSourceVersions) {
  const reference_inputs = (prompt.reference_images ?? []).filter(entry => entry.draft).map(entry => {const {preview_url,...source}=entry.draft!;return {id:entry.id,...source};});
  prompt = { ...prompt, ...(prompt.reference_images ? { reference_images: prompt.reference_images.map(({ draft, ...entry }) => entry) } : {}) };
  return workbenchResponseJson<{ content: StoryPageContentDraft & { dialogue: NonNullable<WorkbenchPage["dialogue"]> }; content_sha256: string; prompt: PagePrompt; prompt_sha256: string; prompt_context_sha256: string; lettering: { page: string; items: LetteringItem[] }; layout_sha256: string }>(await mutateTargetFacts(`${base(projectId)}/page-save`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page_key: page.page_key, content, prompt, reference_inputs,
      expected_content_sha256: page.content_sha256, expected_prompt_sha256: page.prompt_sha256,
      expected_context_sha256: page.prompt_context_sha256, source_versions, lettering: { items }, expected_layout_sha256: page.layout_sha256 }),
  }));
}
