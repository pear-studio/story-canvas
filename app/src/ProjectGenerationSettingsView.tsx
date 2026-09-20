import { useEffect, useMemo, useRef, useState } from "react";
import { useProjectSnapshotReader } from "./use-project-snapshot-reader";

import { responseJson } from "./api-response";
import { useFeedback } from "./feedback";
import { Modal } from "./Modal";
import { UtilityPage, type ProjectSettings } from "./ProjectUtilityViews";
import {
  ResourceDetailsButton,
  ResourcePicker,
  ResourcePreview,
  loraResourceCatalogItem,
  rawLoraCatalogItem,
  resourceBytes,
  type LoraResourceDefinition,
  type LoraResourceEntry,
  type RawLoraResource,
  type ResourceCatalogItem,
  type ResourcePreviewImage,
} from "./ResourceCatalog";
import { mutateFacts, readFacts } from "./project-write-client";
import { alignPromptOverridePieces, splitPromptOverrideText } from "./prompt-override-alignment.mjs";
import RenderProfileInspection, { RenderProfileOverrideInspection, type RenderProfileInspectionProjection } from "./RenderProfileInspection";

type AssetStatus = { id?: string; filename: string; relative_path?: string; size_bytes?: number; sha256?: string; status: string; weight?: number | null };
type RenderProfile = {
  id: string;
  name: string;
  description?: string;
  tags?: string[];
  preview?: { images: ResourcePreviewImage[] } | null;
  architecture_family?: string;
  available: boolean | null;
  diagnosis_loaded?: boolean;
  models: Record<string, AssetStatus>;
  style_loras: Record<string, AssetStatus>;
  errors: string[];
  inspection: RenderProfileInspectionProjection | null;
};
type ProfileResponse = { current_profile_id: string; render_profiles: RenderProfile[] };
type OverrideState = { exists: false } | { exists: true; value: unknown };
type OverrideDocument = { version: 1; profiles: Record<string, { changes: Array<{ target: string; original: OverrideState; project: OverrideState }> }> };
type LoraDefinition = { filename: string; sha256: string; weight: number; trigger?: string };
type LoraResourceList = {
  resources: LoraResourceEntry[];
  raw: RawLoraResource[];
  errors: unknown[];
};

function promptFragmentValue(fragment: RenderProfileInspectionProjection["prompt"]["fragments"][number]) {
  const { id: _id, source: _source, ...value } = fragment;
  return value;
}

function promptOverrideText(state?: { exists: boolean; value?: unknown }) {
  if (!state?.exists || !state.value || typeof state.value !== "object") return null;
  const text = (state.value as { prompt_text?: unknown }).prompt_text;
  return typeof text === "string" ? text : null;
}

function loraDefinition(resource: LoraResourceDefinition): LoraDefinition {
  const recommended = resource.recommended_generation.weight.default;
  const weight = typeof recommended === "number" && recommended >= -2 && recommended <= 2 ? recommended : 1;
  const trigger = resource.activation.trigger_words.join(", ").trim();
  return { filename: resource.file.relative_path.replace(/^loras\//, ""), sha256: resource.file.sha256, weight, ...(trigger ? { trigger } : {}) };
}

function loraFromInspection(lora: RenderProfileInspectionProjection["style_loras"][string]): LoraDefinition {
  return { filename: lora.filename ?? lora.name ?? "", sha256: lora.sha256 ?? "", weight: lora.weight ?? 1, ...(lora.trigger ? { trigger: lora.trigger } : {}) };
}

function removeLoraChanges(changes: OverrideDocument["profiles"][string]["changes"], lora: RenderProfileInspectionProjection["style_loras"][string]) {
  const target = `style_loras.${lora.id}`;
  const weightTarget = `${target}.weight`;
  const whole = changes.find((change) => change.target === target);
  const legacyWeight = changes.find((change) => change.target === weightTarget);
  const remaining = changes.filter((change) => change.target !== target && change.target !== weightTarget);
  if (whole?.original.exists) remaining.push({ target, original: whole.original, project: { exists: false } });
  else if (!whole) remaining.push({ target, original: { exists: true, value: { ...loraFromInspection(lora), ...(legacyWeight?.original.exists ? { weight: legacyWeight.original.value } : {}) } }, project: { exists: false } });
  return remaining;
}

function profileCatalogItem(profile: RenderProfile): ResourceCatalogItem {
  const primary = profile.models.dit ?? profile.models.checkpoint ?? Object.values(profile.models)[0];
  const components = Object.entries(profile.models).filter(([role]) => role !== "dit" && role !== "checkpoint").map(([role, model]) => `${role}: ${model.filename}`);
  const styleLoras = Object.values(profile.style_loras).map((lora) => lora.filename);
  return {
    id: profile.id,
    kind: "base",
    name: profile.name,
    description: profile.description,
    architectureFamily: profile.architecture_family,
    relativePath: primary?.relative_path ?? primary?.filename ?? profile.id,
    sizeBytes: primary?.size_bytes,
    status: profile.available === false ? "unavailable" : "available",
    recordLabel: "生成方案",
    previewImages: profile.preview?.images ?? [],
    tags: profile.tags,
    details: [
      { label: "生成方案", value: profile.id },
      { label: "主模型", value: primary?.relative_path ?? primary?.filename ?? "未读取" },
      { label: "主模型大小", value: resourceBytes(primary?.size_bytes) },
      { label: "配套组件", value: components.join("；") || "无" },
      { label: "预置 LoRA", value: styleLoras.join("、") || "无" },
      { label: "结构家族", value: profile.architecture_family ?? "未说明" },
    ],
  };
}

export default function ProjectGenerationSettingsView({ projectId, project, busy, onSaveProject }: { projectId: string; project: ProjectSettings; busy: boolean; onSaveProject: (project: ProjectSettings) => Promise<void> }) {
  const { confirm, notify } = useFeedback();
  const [profiles, setProfiles] = useState<RenderProfile[]>([]);
  const [loading, setLoading] = useState(true);
  const [inspectionId, setInspectionId] = useState("");
  const [inspectionOverride, setInspectionOverride] = useState<RenderProfile | null>(null);
  const [inspectionLoading, setInspectionLoading] = useState(false);
  const [profilePicker, setProfilePicker] = useState(false);
  const [selectedAdjustmentId, setSelectedAdjustmentId] = useState(project.default_render_profile);
  const [resettingTarget, setResettingTarget] = useState("");
  const [overrideDocument, setOverrideDocument] = useState<OverrideDocument | null>(null);
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [loraResources, setLoraResources] = useState<LoraResourceList | null>(null);
  const [loraPicker, setLoraPicker] = useState(false);
  const [replaceLora, setReplaceLora] = useState<RenderProfileInspectionProjection["style_loras"][string] | null>(null);
  const [loraNotice, setLoraNotice] = useState("");
  const [promptDrafts, setPromptDrafts] = useState<Record<"positive" | "negative", string>>({ positive: "", negative: "" });
  const [promptSaved, setPromptSaved] = useState<Record<"positive" | "negative", string>>({ positive: "", negative: "" });
  const loadGeneration = useRef(0);
  useProjectSnapshotReader(projectId, async (read) => {
    const [next, document] = await Promise.all([
      read<ProfileResponse>(`/api/projects/${encodeURIComponent(projectId)}/render-profile`),
      read<{ override: OverrideDocument }>(`/api/projects/${encodeURIComponent(projectId)}/render-profile-override`),
    ]);
    return () => { loadGeneration.current += 1; setProfiles(next.render_profiles); setOverrideDocument(document.override); setLoading(false); };
  });
  async function refresh() {
    const generation = ++loadGeneration.current;
    setLoading(true);
    try {
      const result = await responseJson<ProfileResponse>(await readFacts(`/api/projects/${encodeURIComponent(projectId)}/render-profile`, { headers: { accept: "application/json" } }));
      if (generation === loadGeneration.current) setProfiles(result.render_profiles);
    } catch (error) { notify({ kind: "error", message: `生成配置读取失败：${error instanceof Error ? error.message : String(error)}` }); }
    finally { setLoading(false); }
  }
  useEffect(() => { setProfiles([]); setInspectionId(""); setInspectionOverride(null); setOverrideDocument(null); setSelectedAdjustmentId(project.default_render_profile); setProfilePicker(false); void refresh(); }, [projectId, project.default_render_profile]);
  useEffect(() => {
    let cancelled = false;
    void fetch("/api/lora-resources", { headers: { accept: "application/json" } }).then((response) => responseJson<LoraResourceList>(response)).then((result) => { if (!cancelled) setLoraResources(result); }).catch((error) => { if (!cancelled) setLoraNotice(`LoRA 资源读取失败：${error instanceof Error ? error.message : String(error)}`); });
    return () => { cancelled = true; };
  }, [projectId]);
  const ordered = useMemo(() => [...profiles].filter((profile) => profile.architecture_family === "anima").sort((left, right) => Number(right.id === project.default_render_profile) - Number(left.id === project.default_render_profile) || left.name.localeCompare(right.name, "zh-CN")), [profiles, project.default_render_profile]);
  const current = profiles.find((profile) => profile.id === project.default_render_profile) ?? null;
  const selectedAdjustment = profiles.find((profile) => profile.id === selectedAdjustmentId) ?? current;
  const selectedAdjustmentCurrent = selectedAdjustment?.id === current?.id;
  const inspected = inspectionOverride?.id === inspectionId ? inspectionOverride : profiles.find((profile) => profile.id === inspectionId) ?? null;
  const styleLoras = Object.values(current?.inspection?.style_loras ?? {});
  const activeLoraBySha = new Map(styleLoras.map((lora) => [lora.sha256, lora]));
  const registeredResources = (loraResources?.resources ?? []).filter(({ resource }) => resource.architecture.family === current?.architecture_family && resource.architecture.prompt_family === current?.inspection?.prompt.family);
  const rawResources = (loraResources?.raw ?? []).map((raw) => ({ raw, resource: { id: raw.id, name: raw.name, file: { relative_path: raw.relative_path, sha256: raw.sha256, size_bytes: raw.size_bytes }, architecture: { family: current?.architecture_family ?? "other", prompt_family: current?.inspection?.prompt.family ?? "universal" }, base_models: [], activation: { trigger_words: [], tags: [] }, recommended_generation: { weight: { default: 1, minimum: null, maximum: null, status: "untested" }, clip_skip: null, sampler: null, scheduler: null, steps: null, cfg: null, status: "untested" }, description: "未登记的本机 LoRA", usage_notes: "", source: { type: "local_file" }, previews: [], examples: [] } satisfies LoraResourceDefinition }));
  const selectableResources = [
    ...registeredResources.map((entry) => ({ resource: entry.resource, catalogItem: loraResourceCatalogItem(entry) })),
    ...rawResources.map(({ raw, resource }) => ({ resource, catalogItem: rawLoraCatalogItem(raw) })),
  ].filter(({ resource }) => !activeLoraBySha.has(resource.file.sha256));
  const selectableResourceById = new Map(selectableResources.map((entry) => [entry.catalogItem.id, entry.resource]));
  const basePickerItems = ordered.filter((profile) => profile.id !== project.default_render_profile).map(profileCatalogItem);
  const promptFragments = current?.inspection?.prompt.fragments ?? [];
  const promptChanges = [...(current?.inspection?.project_override.changes ?? []), ...(current?.inspection?.project_override.conflicts ?? [])];
  const promptChangeByTarget = new Map(promptChanges.filter((change) => change.target.startsWith("prompt.fragments.")).map((change) => [change.target, change]));
  const promptSeparator = current?.inspection?.prompt.separator || ", ";
  const promptEntries = promptFragments.map((fragment) => { const change = promptChangeByTarget.get(`prompt.fragments.${fragment.id}`); return { fragment, text: promptOverrideText(change?.project) ?? fragment.prompt_text, baseText: promptOverrideText(change?.current) ?? fragment.prompt_text }; });
  const promptGroups = (["positive", "negative"] as const).map((polarity) => {
    const entries = promptEntries.filter((entry) => entry.fragment.polarity === polarity);
    return { polarity, entries, text: entries.map((entry) => entry.text).join(promptSeparator), hasChanges: entries.some((entry) => promptChangeByTarget.has(`prompt.fragments.${entry.fragment.id}`)) };
  });
  useEffect(() => {
    const next = Object.fromEntries(promptGroups.map((group) => [group.polarity, group.text])) as Record<"positive" | "negative", string>;
    setPromptDrafts(next); setPromptSaved(next);
  }, [current?.inspection?.project_override.effective_sha256, projectId]);

  async function saveChoice(patch: Partial<Pick<ProjectSettings, "canvas" | "default_render_profile">>) {
    const label = patch.canvas ? "画面比例" : "基模";
    if (!await confirmDiscardPromptDrafts()) return false;
    const message = patch.canvas ? "修改画面比例只影响之后的生成，已有图片会保留。是否继续？" : "切换基模会同时切换对应的 Prompt 和采样方案，只影响之后的生成；已有图片会保留。是否继续？";
    if (!await confirm({ kind: "warning", title: `修改${label}`, message })) return false;
    await onSaveProject({ ...project, ...patch });
    return true;
  }

  async function readOverrideDocument() {
    if (overrideDocument) return overrideDocument;
    const result = await responseJson<{ override: OverrideDocument }>(await readFacts(`/api/projects/${encodeURIComponent(projectId)}/render-profile-override`, { headers: { accept: "application/json" } }));
    setOverrideDocument(result.override);
    return result.override;
  }

  async function putOverrideDocument(next: OverrideDocument) {
    const result = await responseJson<{ saved: true; override: OverrideDocument }>(await mutateFacts(`/api/projects/${encodeURIComponent(projectId)}/render-profile-override`, { method: "PUT", headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(next) }));
    setOverrideDocument(result.override);
    await refresh();
  }

  async function inspectProfile(profile: RenderProfile) {
    setInspectionId(profile.id);
    setInspectionOverride(null);
    if (profile.inspection) return;
    setInspectionLoading(true);
    try {
      const result = await responseJson<{ render_profiles: RenderProfile[] }>(await fetch("/api/resources", { headers: { accept: "application/json" } }));
      const full = result.render_profiles.find((entry) => entry.id === profile.id) ?? null;
      if (!full) throw new Error("资源目录中没有这项模型配置");
      setInspectionOverride(full);
    } catch (error) {
      notify({ kind: "error", message: `模型配置详情读取失败：${error instanceof Error ? error.message : String(error)}` });
    } finally { setInspectionLoading(false); }
  }

  function closeLoraPicker() {
    setLoraPicker(false);
    setReplaceLora(null);
  }

  async function updateStyleLora(resource: LoraResourceDefinition | null, action: "add" | "remove", selectedActive?: RenderProfileInspectionProjection["style_loras"][string]) {
    if (!current?.inspection || overrideBusy) return;
    const active = selectedActive ?? (resource ? activeLoraBySha.get(resource.file.sha256) : undefined);
    const id = active?.id ?? resource?.id;
    if (!id || (action === "add" && !resource)) return;
    if (!await confirmDiscardPromptDrafts()) return;
    setOverrideBusy(true); setLoraNotice("");
    try {
      const document = await readOverrideDocument();
      const group = document.profiles[current.id] ?? { changes: [] };
      let changes = group.changes.filter((change) => change.target !== `style_loras.${id}`);
      if (action === "add") changes.push({ target: `style_loras.${id}`, original: { exists: false }, project: { exists: true, value: loraDefinition(resource!) } });
      else if (active) changes = removeLoraChanges(group.changes, active);
      await putOverrideDocument({ ...document, profiles: { ...document.profiles, [current.id]: { ...group, changes } } });
      if (action === "add") closeLoraPicker();
    } catch (error) { setLoraNotice(`LoRA 更新失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setOverrideBusy(false); }
  }

  async function replaceStyleLora(resource: LoraResourceDefinition, selectedActive: RenderProfileInspectionProjection["style_loras"][string]) {
    if (!current?.inspection || overrideBusy || selectedActive.sha256 === resource.file.sha256) return;
    if (!await confirmDiscardPromptDrafts()) return;
    setOverrideBusy(true); setLoraNotice("");
    try {
      const document = await readOverrideDocument();
      const group = document.profiles[current.id] ?? { changes: [] };
      const target = `style_loras.${resource.id}`;
      const changes = removeLoraChanges(group.changes, selectedActive).filter((change) => change.target !== target);
      changes.push({ target, original: { exists: false }, project: { exists: true, value: loraDefinition(resource) } });
      await putOverrideDocument({ ...document, profiles: { ...document.profiles, [current.id]: { ...group, changes } } });
      closeLoraPicker();
    } catch (error) { setLoraNotice(`LoRA 替换失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setOverrideBusy(false); }
  }

  async function updateStyleLoraWeight(lora: RenderProfileInspectionProjection["style_loras"][string], weight: number) {
    if (!current?.inspection || overrideBusy || !Number.isFinite(weight) || weight < -2 || weight > 2) return;
    if (!await confirmDiscardPromptDrafts()) return;
    const target = `style_loras.${lora.id}`;
    setOverrideBusy(true); setLoraNotice("");
    try {
      const document = await readOverrideDocument();
      const group = document.profiles[current.id] ?? { changes: [] };
      const weightTarget = `${target}.weight`;
      const whole = group.changes.find((change) => change.target === target);
      const legacyWeight = group.changes.find((change) => change.target === weightTarget);
      const changes = group.changes.filter((change) => change.target !== target && change.target !== weightTarget);
      if (whole?.project.exists && whole.project.value && typeof whole.project.value === "object") {
        changes.push({ ...whole, project: { exists: true, value: { ...whole.project.value as Record<string, unknown>, weight } } });
      } else {
        const original = legacyWeight?.original ?? { exists: true as const, value: lora.weight ?? 1 };
        if (original.exists && original.value !== weight) changes.push({ target: weightTarget, original, project: { exists: true, value: weight } });
      }
      await putOverrideDocument({ ...document, profiles: { ...document.profiles, [current.id]: { ...group, changes } } });
    } catch (error) { setLoraNotice(`LoRA 权重保存失败：${error instanceof Error ? error.message : String(error)}`); }
    finally { setOverrideBusy(false); }
  }

  const promptDirty = promptGroups.some(({ polarity }) => promptDrafts[polarity] !== promptSaved[polarity]);
  const promptHasChanges = promptChanges.some((change) => change.target.startsWith("prompt.fragments."));

  async function confirmDiscardPromptDrafts() {
    if (!promptDirty) return true;
    return confirm({
      kind: "warning",
      title: "放弃未保存的 Prompt？",
      message: "继续后会重新读取生成配置，当前未保存的 Prompt 修改将丢失。",
      confirmLabel: "放弃并继续",
    });
  }

  async function savePromptOverrides() {
    if (!current?.inspection || overrideBusy || !promptDirty) return;
    setOverrideBusy(true);
    try {
      const document = await readOverrideDocument();
      const group = document.profiles[current.id] ?? { changes: [] };
      const byTarget = new Map(group.changes.map((change) => [change.target, change]));
      for (const { polarity, entries } of promptGroups) {
        if (promptDrafts[polarity] === promptSaved[polarity]) continue;
        const pieces = splitPromptOverrideText(promptDrafts[polarity], promptSeparator);
        const normalized = pieces.length > entries.length && entries.length ? [...pieces.slice(0, entries.length - 1), pieces.slice(entries.length - 1).join(promptSeparator).trim()] : pieces;
        const values = alignPromptOverridePieces(entries, normalized);
        entries.forEach(({ fragment, baseText }, index) => {
          const target = `prompt.fragments.${fragment.id}`;
          const existing = byTarget.get(target);
          const original = existing?.original ?? { exists: true as const, value: promptFragmentValue(fragment) };
          const value = values[index];
          if (value == null) byTarget.set(target, { target, original, project: { exists: false } });
          else if (value === baseText) byTarget.delete(target);
          else {
            const baseValue = original.exists && original.value && typeof original.value === "object" ? original.value as Record<string, unknown> : promptFragmentValue(fragment);
            byTarget.set(target, { target, original, project: { exists: true, value: { ...baseValue, prompt_text: value } } });
          }
        });
      }
      await putOverrideDocument({ ...document, profiles: { ...document.profiles, [current.id]: { ...group, changes: [...byTarget.values()] } } });
      notify({ kind: "success", message: "Prompt 调整已保存" });
    } catch (error) { notify({ kind: "error", message: `Prompt 调整保存失败：${error instanceof Error ? error.message : String(error)}` }); }
    finally { setOverrideBusy(false); }
  }

  async function resetPromptOverrides() {
    if (!current || overrideBusy || !promptHasChanges || !await confirmDiscardPromptDrafts() || !await confirm({ kind: "warning", title: "恢复 Prompt 基础值", message: "恢复当前模型配置的全部 Prompt 基础值？其他项目调整不会改变。" })) return;
    setOverrideBusy(true);
    try {
      const document = await readOverrideDocument();
      const group = document.profiles[current.id] ?? { changes: [] };
      await putOverrideDocument({ ...document, profiles: { ...document.profiles, [current.id]: { ...group, changes: group.changes.filter((change) => !change.target.startsWith("prompt.fragments.")) } } });
    } catch (error) { notify({ kind: "error", message: `Prompt 重置失败：${error instanceof Error ? error.message : String(error)}` }); }
    finally { setOverrideBusy(false); }
  }

  async function resetChange(target: string) {
    if (!current || resettingTarget || !await confirmDiscardPromptDrafts() || !await confirm({ kind: "warning", title: "恢复基础值", message: "恢复这项基础值？其他项目调整不会改变。" })) return;
    setResettingTarget(target);
    try {
      const result = await responseJson<{ override: OverrideDocument }>(await readFacts(`/api/projects/${encodeURIComponent(projectId)}/render-profile-override`, { headers: { accept: "application/json" } }));
      const group = result.override.profiles[current.id] ?? { changes: [] };
      const next = { ...result.override, profiles: { ...result.override.profiles, [current.id]: { ...group, changes: group.changes.filter((change) => change.target !== target) } } };
      await responseJson(await mutateFacts(`/api/projects/${encodeURIComponent(projectId)}/render-profile-override`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(next) }));
      await refresh();
      notify({ kind: "success", message: "项目调整已恢复为基础值" });
    } catch (error) { notify({ kind: "error", message: `恢复调整失败：${error instanceof Error ? error.message : String(error)}` }); }
    finally { setResettingTarget(""); }
  }

  const selectedOverride = selectedAdjustment?.inspection?.project_override;
  const selectedOverrideStatus = selectedOverride?.blocked ? "conflict" : selectedOverride?.changes.length ? "applied" : "none";
  return <UtilityPage title="生成设置" description="基模、LoRA、画面比例与项目调整">
    <section className="settings-card project-generation-settings-card"><header className="project-generation-settings-card__header"><div><span className="settings-eyebrow">当前项目</span><h3>当前生成设置</h3><p>基模会带入对应的 Prompt 和采样方案；画面比例只影响之后的新生成。</p></div><div className="card-actions"><button className="button" type="button" disabled={busy || loading} onClick={() => setProfilePicker(true)}>选择基模</button></div></header>
      <div className="project-generation-summary__facts"><div><span>基模</span><b>{current?.name ?? project.default_render_profile}</b></div><div><span>画面比例</span><b>{project.canvas}</b></div><div><span>项目 LoRA</span><b>{styleLoras.length ? `${styleLoras.length} 项` : "未启用"}</b></div></div>
      <section className="project-generation-canvas project-generation-canvas--inline"><header><div><h4>画面比例</h4><p>已有图片不会改变。</p></div></header><div className="canvas-choice-list">{["3:4", "2:3", "9:16", "4:3"].map((canvas) => <button type="button" role="radio" aria-checked={project.canvas === canvas} className={`canvas-choice ${project.canvas === canvas ? "is-selected" : ""}`} disabled={busy} key={canvas} onClick={() => void saveChoice({ canvas })}><span className={`canvas-choice__preview canvas-choice__preview--${canvas.replace(":", "-")}`} /><b>{canvas}</b></button>)}</div></section>
      <section className="project-lora-settings"><header><div><h4>项目 LoRA</h4><p>启用后按项目权重加载；资源提供的触发词自动加入 Positive。</p></div><button className="button" type="button" disabled={overrideBusy || !current?.inspection} onClick={() => { setReplaceLora(null); setLoraPicker(true); }}>选择 LoRA</button></header>
        {!loraResources && <div className="project-prompt-override__readonly">正在读取 LoRA 资源…</div>}{loraResources && !styleLoras.length && <div className="project-prompt-override__readonly">当前项目未启用 LoRA。</div>}
        {styleLoras.length > 0 && <div className="project-lora-current-list">{styleLoras.map((lora) => {
          const registered = (loraResources?.resources ?? []).find(({ resource }) => resource.file.sha256 === lora.sha256);
          const raw = (loraResources?.raw ?? []).find((resource) => resource.sha256 === lora.sha256);
          const resource = registered?.resource ?? rawResources.find((entry) => entry.raw.sha256 === lora.sha256)?.resource ?? null;
          const item = registered ? loraResourceCatalogItem(registered) : raw ? rawLoraCatalogItem(raw) : { id: lora.id, kind: "lora" as const, name: lora.name ?? lora.filename ?? lora.id, relativePath: lora.filename ?? lora.id, status: lora.available ? "available" : "missing", recordLabel: "项目配置", details: [{ label: "文件", value: lora.filename ?? lora.id }, { label: "SHA-256", value: lora.sha256 ?? "未读取" }] };
          return <article className={lora.available ? "" : "has-warning"} key={lora.id}><ResourcePreview compact images={item.previewImages} placeholder="LoRA" /><div className="project-lora-current__body"><header><div><b>{item.name}</b><small>{lora.filename}</small></div><span>{lora.available ? "可用" : "需处理"}</span></header><div className="project-lora-current__details"><ResourceDetailsButton item={item} label="资源详情" /></div><footer><label><span>项目权重</span><input key={`${lora.id}-${lora.weight}`} type="number" min="-2" max="2" step="0.05" defaultValue={lora.weight ?? 1} disabled={overrideBusy} onBlur={(event) => { const weight = Number(event.currentTarget.value); if (weight !== lora.weight) void updateStyleLoraWeight(lora, weight); }} /></label><div className="project-lora-current__actions"><button className="button button--quiet" type="button" disabled={overrideBusy} onClick={() => { setReplaceLora(lora); setLoraPicker(true); }}>替换</button><button className="button button--quiet" type="button" disabled={overrideBusy} onClick={() => void updateStyleLora(resource, "remove", lora)}>移除</button></div></footer></div></article>;
        })}</div>}
        {loraNotice && <p className="project-lora-settings__notice">{loraNotice}</p>}
      </section>
    </section>
    <section className="settings-card project-adjustments" data-project-fact-dirty={promptDirty ? "true" : undefined}><header className="project-adjustments__header"><div><span className="settings-eyebrow">项目级调整</span><h3>项目调整</h3><p>调整只写入当前项目，不会复制整套模型配置。</p></div>{selectedAdjustment?.inspection && <span className={`project-adjustments__status project-adjustments__status--${selectedOverrideStatus}`}>{selectedOverrideStatus === "conflict" ? "需要处理" : selectedOverrideStatus === "applied" ? "已设置" : "未设置"}</span>}</header>
      <div className="project-adjustments__selector"><label><span>调整对象</span><select value={selectedAdjustment?.id ?? ""} onChange={(event) => setSelectedAdjustmentId(event.target.value)}>{ordered.map((profile) => <option value={profile.id} key={profile.id}>{profile.name}{profile.id === current?.id ? "（当前）" : ""}</option>)}</select></label><p>{selectedAdjustmentCurrent ? "下面的调整会用于当前项目后续生成。" : "这里只读查看其他模型配置；切换为当前配置后才能修改。"}</p></div>
      {selectedAdjustment?.inspection ? <RenderProfileOverrideInspection inspection={selectedAdjustment.inspection} isCurrent={selectedAdjustmentCurrent} embedded onResetChange={selectedAdjustmentCurrent ? (target) => void resetChange(target) : undefined} resettingTarget={resettingTarget || null} /> : <div className="empty-card">{selectedAdjustment?.errors.join("；") || "当前模型配置没有可读取的项目调整。"}</div>}
      {current?.inspection && selectedAdjustmentCurrent && <section className="project-prompt-override"><header><div><h4>Prompt 调整</h4><p>基于当前模型配置已有 Prompt，直接调整完整的正向和负向文本。</p></div></header><div className="project-prompt-override__groups">{promptGroups.map(({ polarity, entries, hasChanges }) => <label className="project-prompt-override__field project-prompt-override__field--combined" key={polarity}><span><b>{polarity === "positive" ? "正向 Prompt" : "负向 Prompt"}</b>{hasChanges ? <i>已有调整</i> : <em>基础值</em>}</span><textarea value={promptDrafts[polarity]} onChange={(event) => { const text = event.currentTarget.value; setPromptDrafts((value) => ({ ...value, [polarity]: text })); }} disabled={overrideBusy || !entries.length} rows={5} placeholder={entries.length ? "输入 Prompt 文本" : "没有可调整的片段"} /></label>)}</div><div className="project-prompt-override__footer">{promptHasChanges && <button className="button button--quiet" type="button" disabled={overrideBusy} onClick={() => void resetPromptOverrides()}>重置 Prompt</button>}<button className="button button--primary" type="button" disabled={overrideBusy || !promptDirty || !promptEntries.length} onClick={() => void savePromptOverrides()}>{overrideBusy ? "保存中…" : "保存 Prompt 调整"}</button>{promptDirty && <span>有未保存修改</span>}</div></section>}
    </section>
    {profilePicker && <Modal size="workspace" title="选择基模" subtitle="当前项目" onClose={() => setProfilePicker(false)} busy={busy} ariaLabel="选择基模"><div className="profile-picker-body"><ResourcePicker items={basePickerItems} busy={busy} empty="没有其他可选择的基模。" onInspect={(item) => { const profile = profiles.find((entry) => entry.id === item.id); if (!profile) return; setProfilePicker(false); void inspectProfile(profile); }} onSelect={(item) => { const profile = profiles.find((entry) => entry.id === item.id); if (!profile) return; void (async () => { if (await saveChoice({ default_render_profile: profile.id })) setProfilePicker(false); })(); }} /></div></Modal>}
    {inspectionId && <Modal size="workspace" title={inspected?.name ?? "模型配置"} subtitle="模型配置" onClose={() => { setInspectionId(""); setInspectionOverride(null); }} ariaLabel={`查看模型配置：${inspected?.name ?? inspectionId}`}><div className="profile-inspection-body">{inspectionLoading ? <section className="panel"><p>正在读取完整配置…</p></section> : inspected?.inspection ? <RenderProfileInspection inspection={inspected.inspection} isCurrent={inspected.id === project.default_render_profile} /> : <section className="panel"><h3>配置详情不可用</h3><p>{inspected?.errors.join("；") || "资源目录没有返回可检查内容。"}</p></section>}</div></Modal>}
    {loraPicker && <Modal size="workspace" title="选择 LoRA" subtitle={current?.name ?? "当前基模"} onClose={closeLoraPicker} busy={overrideBusy} ariaLabel="选择 LoRA"><div className="lora-picker-body"><div className="lora-picker-summary"><b>{replaceLora ? `为「${replaceLora.name ?? replaceLora.filename ?? replaceLora.id}」选择替代资源` : `${selectableResources.length} 个兼容 LoRA`}</b><p>{replaceLora ? "选择后将替换当前项；项目权重仍在生成设置中管理。" : "选择后将加入当前项目；项目权重和已启用 LoRA 仍在生成设置中管理。"}</p></div><ResourcePicker items={selectableResources.map((entry) => entry.catalogItem)} busy={overrideBusy} empty="当前没有其他可选择的 LoRA。" onSelect={(item) => { const resource = selectableResourceById.get(item.id); if (!resource) return; if (replaceLora) void replaceStyleLora(resource, replaceLora); else void updateStyleLora(resource, "add"); }} />{(loraResources?.errors.length ?? 0) > 0 && <div className="project-prompt-override__readonly">另有 {loraResources!.errors.length} 条 LoRA 资源记录无效，已隐藏。</div>}</div></Modal>}
  </UtilityPage>;
}
