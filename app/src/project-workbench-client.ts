import type { TextPageLayout } from "../shared/text-page-layout.mjs";
import type { PageKey } from "./page-key";
import { workbenchResponseJson } from "./api-response";
import type { StoryContentWarning } from "../shared/story-content-guidance.mjs";
import {
  mutateDerived,
  mutateFacts,
  mutateTargetFacts,
  PROJECT_REVISION_HEADER,
  readFacts,
} from "./project-write-client";
import type { LetteringItem, LetteringSettings } from "./lettering";

export const promptCategories = ["subject","person","setting","camera","avoid"] as const;

export type PromptCategory = typeof promptCategories[number];
export type PromptFragment = {
  id?: string;
  tag?: string;
  description?: string;
  camera_settings?: import("../shared/camera-prompt.mjs").CameraSettings;
  character_id?: string;
  weight?: number;
  enabled?: boolean;
};
export type FreePrompt = { base_sha256?: string; positive: string; negative: string; loras: CharacterLora[] };
export type InheritedAdjustments = Record<string, { weight?: number; enabled?: boolean }>;
export type SettingKind = 'character' | 'scene';
export type Scene = WorkbenchCharacter;
export type PageOwner = { page_id: string; owner_kind: 'story' | 'character' | 'scene'; sequence_id?: string; character_id?: string; scene_id?: string; variant_id?: string };
export type PagePrompt = Record<PromptCategory, PromptFragment[]> & { mode?: "structured" | "free"; free?: FreePrompt; reference_image?: string; scene_id?: string; scene_variant_id?: string; inheritance?: Record<string, InheritedAdjustments> };
export type CharacterLora = { filename: string; sha256: string; weight: number; trigger?: string };
export type CharacterPromptSetting = {
  prompt: PagePrompt;
  loras: CharacterLora[];
  /** 本造型排除的 identity.prompt 文本键（tag/description 文本）；必有，可为空数组。 */
  identity_disabled: string[];
  identity_overrides?: InheritedAdjustments;
};
export type CharacterPromptIdentity = {
  prompt: PagePrompt;
  lora: CharacterLora | null;
};
export type CharacterPromptDocument = {
  identity: CharacterPromptIdentity;
  /** 键为子设定 ID，与 visual.variants 一一对应；无保留 id。 */
  variants: Record<string, CharacterPromptSetting>;
};
export type CharacterPromptIdentityImpact = {
  per_variant: Record<string, { lost_inheritance: string[]; new_inheritance: string[] }>;
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
  content_sha256: string;
  prompt: PagePrompt;
  prompt_sha256: string;
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
export type WorkbenchCharacter = {
  id: string;
  name: string;
  description: string;
  profile_sha256: string;
  visual: { description?: string; variants: Array<{ id: string; name: string; description?: string }> };
  visual_sha256: string;
  prompt: CharacterPromptDocument;
  prompt_sha256: string;
  style: { display_color: string } | null;
  pages: WorkbenchPage[];
};
export type ProjectWorkbenchView = {
  scenes?: { scenes: Scene[] };
  scenes_sha256?: string;
  pages?: WorkbenchPage[];
  orphan_pages?: WorkbenchPage[];
  version: 4;
  project: { id: string; title: string; canvas: string | null; default_render_profile: string | null; lettering_settings: LetteringSettings | null; lettering_settings_sha256: string | null };
  outline: {
    synopsis: string;
    synopsis_sha256: string;
    chapters: Array<{ id: string; title: string; summary: string; summary_sha256: string; sequences: Array<{ id: string; title: string; summary: string; summary_sha256: string; pages: WorkbenchPage[] }> }>;
  };
  characters: WorkbenchCharacter[];
  render_capabilities: {
    text_page?: { dimensions: { width: number; height: number } | null; error: string | null };
    candidates: { available: boolean; counts: number[]; blocker?: string; details?: string[] };
  };
  diagnostics: Array<{ code: string; [key: string]: unknown }>;
};

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

export async function loadProjectWorkbench(projectId: string, signal?: AbortSignal) {
  const response = await readFacts(base(projectId), { headers: { accept: "application/json" }, signal });
  const view = await workbenchResponseJson<ProjectWorkbenchView>(response);
  const revision = response.headers.get(PROJECT_REVISION_HEADER);
  if (!revision) throw new Error("工作台响应缺少项目 revision");
  return { view, revision };
}

export async function loadProjectRevision(projectId: string, signal?: AbortSignal) {
  return workbenchResponseJson<{ revision: string }>(await readFacts(`/api/projects/${encodeURIComponent(projectId)}/revision`, { cache: "no-store", signal }));
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

export async function savePagePrompt(projectId: string, page: WorkbenchPage, prompt: PagePrompt, confirmationSha256?: string) {
  return workbenchResponseJson<{ kind: WorkbenchPage["kind"]; page_id: string; prompt: PagePrompt; prompt_sha256: string }>(await mutateTargetFacts(`${base(projectId)}/page-prompt`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ kind: page.kind, page_id: page.page_id, prompt, confirmation_sha256: confirmationSha256, expected_sha256: page.prompt_sha256, expected_context_sha256: page.prompt_context_sha256 }),
  }));
}

export async function saveCharacterPrompt(projectId: string, character: WorkbenchCharacter, prompt: CharacterPromptDocument, confirmationSha256?: string, kind: SettingKind = "character") {
  return workbenchResponseJson<{ character_id: string; prompt: CharacterPromptDocument; prompt_sha256: string; identity_impact: CharacterPromptIdentityImpact | null }>(await mutateTargetFacts(`${base(projectId)}/${kind}-prompt`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      [`${kind}_id`]: character.id,
      prompt,
      expected_sha256: character.prompt_sha256,
      expected_visual_sha256: character.visual_sha256,
      confirmation_sha256: confirmationSha256,
    }),
  }));
}

export type CharacterProfileDraft = Pick<WorkbenchCharacter, "name" | "description">;
export type CharacterVisualDraft = WorkbenchCharacter["visual"];

export async function saveCharacterProfile(projectId: string, character: WorkbenchCharacter, profile: CharacterProfileDraft, kind: SettingKind = "character") {
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

export async function saveCharacterVisual(projectId: string, character: WorkbenchCharacter, visual: CharacterVisualDraft, kind: SettingKind = "character") {
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

export async function renameCharacterVariant(projectId: string, character: WorkbenchCharacter, oldId: string, newId: string, kind: SettingKind = "character") {
  return workbenchResponseJson<{
    character_id: string;
    visual: CharacterVisualDraft;
    visual_sha256: string;
    prompt: CharacterPromptDocument;
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

export async function savePageContent(
  projectId: string,
  page: WorkbenchPage,
  content: StoryPageContentDraft | CharacterPageContentDraft,
  confirmationSha256?: string,
) {
  return workbenchResponseJson<{
    page_key: WorkbenchPage["page_key"];
    content: StoryPageContentDraft | CharacterPageContentDraft;
    content_sha256: string;
    prompt?: PagePrompt;
    prompt_sha256?: string;
    prompt_context_sha256: string | null;
    downstream_diagnostics: Array<{ code: string }>;
    warnings: StoryContentWarning[];
  }>(await mutateTargetFacts(`${base(projectId)}/page-content`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page_key: page.page_key, content, confirmation_sha256: confirmationSha256, expected_sha256: page.content_sha256 }),
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
  options: { operation: "candidates"; count: number; seed?: number },
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

export type PageRenderPromptPart = {
  category: string | null;
  role: string | null;
  prompt_type: string | null;
  prompt_text: string;
  weight: number;
  origin: string;
  origin_id: string | null;
  polarity: "positive" | "negative";
  path: string;
  text: string;
  [key: string]: unknown;
};

export type GenerationDetails = {
  prompt_mode?: "structured" | "free";
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
    separator: string;
    parts: {
      positive: PageRenderPromptPart[];
      negative: PageRenderPromptPart[];
    };
  };
};

export type PageRenderInspection = {
  generation_signature: string | null;
  structured_import: FreePrompt | null;
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
    separator: string;
    parts: {
      positive: PageRenderPromptPart[];
      negative: PageRenderPromptPart[];
      by_category: Record<PromptCategory, PageRenderPromptPart[]>;
    };
  };
  characters: Array<{
    character_id: string;
    name: string;
    variant_id: string | null;
    configuration_id: string;
    loras: Array<CharacterLora & { diagnosis: unknown }>;
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
      prompt_family: string;
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

export async function inspectPageRender(
  projectId: string,
  pageKey: WorkbenchPage["page_key"],
  prompt?: PagePrompt,
) {
  return workbenchResponseJson<{ inspection: PageRenderInspection }>(await readFacts(`${base(projectId)}/page-render-inspection`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ page_key: pageKey, ...(prompt === undefined ? {} : { prompt }) }),
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

export const saveSettingProfile = (kind: SettingKind, projectId: string, setting: WorkbenchCharacter, draft: CharacterProfileDraft) => saveCharacterProfile(projectId, setting, draft, kind);
export const saveSettingVisual = (kind: SettingKind, projectId: string, setting: WorkbenchCharacter, draft: CharacterVisualDraft) => saveCharacterVisual(projectId, setting, draft, kind);
export const saveSettingPrompt = (kind: SettingKind, projectId: string, setting: WorkbenchCharacter, draft: CharacterPromptDocument, confirmation?: string) => saveCharacterPrompt(projectId, setting, draft, confirmation, kind);
export const renameSettingVariant = (kind: SettingKind, projectId: string, setting: WorkbenchCharacter, oldId: string, newId: string) => renameCharacterVariant(projectId, setting, oldId, newId, kind);

export async function saveWholePage(projectId: string, page: WorkbenchPage, content: StoryPageContentDraft, prompt: PagePrompt, items: LetteringItem[], confirmationSha256?: string) {
  return workbenchResponseJson<{ content: StoryPageContentDraft & { dialogue: NonNullable<WorkbenchPage["dialogue"]> }; content_sha256: string; prompt: PagePrompt; prompt_sha256: string; prompt_context_sha256: string; lettering: { page: string; items: LetteringItem[] }; layout_sha256: string }>(await mutateTargetFacts(`${base(projectId)}/page-save`, {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ page_key: page.page_key, content, prompt,
      expected_content_sha256: page.content_sha256, expected_prompt_sha256: page.prompt_sha256,
      expected_context_sha256: page.prompt_context_sha256, lettering: { items }, expected_layout_sha256: page.layout_sha256,
      confirmation_sha256: confirmationSha256 }),
  }));
}
