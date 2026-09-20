import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { responseJson } from "./api-response";
import { comparisonAxisLabel } from "./comparison-grid";
import { useFeedback } from "./feedback";
import ZoomableImageLightbox from "./ImageLightbox";
import { Modal } from "./Modal";
import { ComparisonInputEditor, type ComparisonInput } from "./ComparisonInputEditor";
import { ResourcePicker, ResourceDetailsButton, resourceStatusLabel } from "./ResourceCatalog";
import { loraResourceItem, loraMatchesProfile, type GlobalModelResource } from "./global-resource-catalog";


import type { TaskCollection } from "./runtime-status";
import { comparisonRuntimeSyncPlan } from "./comparison-runtime-sync";
import { WorkspaceHeader } from "./WorkspaceHeader";
export { comparisonRuntimeSyncPlan } from "./comparison-runtime-sync";



type ComparisonResources = { models: GlobalModelResource[] };
type AxisValue = { value_id: string; label: string; value?: string | number };
type ComparisonAxis = { type: string; values: AxisValue[] };
type ComparisonManifestCell = { id: string; ordinal: number; axis_values: Record<string, string>; effective_seed?: number };
type ComparisonStatusCell = { id: string; ordinal: number; status?: string; result?: { image?: { relative_path?: string } } | null; error?: { message?: string } | null };
type ComparisonRecord = {
  id: string;
  manifest: { id: string; axes: ComparisonAxis[]; cells: ComparisonManifestCell[]; shared_seed: number | null; created_at: string };
  status: { status: "queued" | "running" | "completed" | "failed" | "cancelled" | "incomplete"; cells: ComparisonStatusCell[]; updated_at: string; started_at?: string | null };
  execution?: unknown;
  retry_available?: boolean;
};

type ComparisonGridState = {
  xAxis: string;
  yAxis: string;
  slices: Record<string, string>;
  horizontalAxis: string;
  verticalAxis: string;
};

type PageFilter = "all" | "story" | "character";
type ComparisonImagePreview = { src: string; alt: string; footer: string };

const statusLabels: Record<ComparisonRecord["status"]["status"], string> = {
  queued: "待开始", running: "生成中", completed: "已完成", failed: "失败", cancelled: "已取消", incomplete: "未完成",
};

function parseNumberList(text: string, label: string) {
  if (!text.trim()) return [];
  const values = text.split(",").map((item) => item.trim()).filter(Boolean).map(Number);
  if (values.some((value) => !Number.isFinite(value))) throw new Error(`${label}请填写逗号分隔的数字`);
  return values;
}

function axisValues(type: string, values: Array<string | number>, labels = values.map(String)): ComparisonAxis {
  return {
    type,
    values: values.map((value, index) => ({
      value_id: `${type}-${index + 1}`,
      label: labels[index] ?? String(value),
      value,
    })),
  };
}

function mergeRecord(records: ComparisonRecord[], next: ComparisonRecord) {
  const index = records.findIndex((record) => record.id === next.id);
  if (index < 0) return [next, ...records];
  return records.map((record, current) => current === index ? next : record);
}

function progress(record: ComparisonRecord) {
  const cells = record.status.cells ?? [];
  return { done: cells.filter((cell) => cell.status === "completed").length, total: record.manifest.cells.length };
}

function gridAxes(axes: ComparisonAxis[]) {
  const varying = axes.filter((axis) => axis.values.length > 1);
  return varying.length ? varying : axes.slice(0, 1);
}

function axisOptionLabel(axis: ComparisonAxis) {
  return `${comparisonAxisLabel(axis.type)} x${axis.values.length}`;
}

function ComparisonGridImage({ src, label, onOpen }: { src: string; label: string; onOpen: () => void }) {
  const [displayed, setDisplayed] = useState<{ src: string; width: number; height: number } | null>(null);
  const [failedSrc, setFailedSrc] = useState("");
  const currentSrc = useRef(src);
  currentSrc.current = src;
  const loaded = displayed?.src === src;
  const failed = failedSrc === src;
  return <button
    type="button"
    className={`comparison-result-grid__image ${loaded ? "is-loaded" : "is-loading"}`}
    style={displayed ? { aspectRatio: `${displayed.width} / ${displayed.height}` } : undefined}
    aria-label={`放大查看：${label}`}
    aria-disabled={!loaded}
    aria-busy={!loaded && !failed}
    title={loaded ? "点击放大查看" : undefined}
    onClick={loaded ? onOpen : undefined}
  >
    {displayed && <img src={displayed.src} width={displayed.width} height={displayed.height} alt={loaded ? label : "上一张预览，新图加载中"} />}
    {!loaded && <>
      <span className="comparison-result-grid__loading" aria-live="polite">{failed ? "加载失败" : "正在加载…"}</span>
      <img className="comparison-result-grid__pending" key={src} loading="lazy" src={src} alt="" aria-hidden="true" onLoad={async event => {
        const image = event.currentTarget;
        try {
          await image.decode();
          if (currentSrc.current === src) setDisplayed({ src, width: image.naturalWidth, height: image.naturalHeight });
        } catch {
          if (currentSrc.current === src) setFailedSrc(src);
        }
      }} onError={() => { if (currentSrc.current === src) setFailedSrc(src); }} />
    </>}
  </button>;
}

function chooseGridAxes(axes: ComparisonAxis[]) {
  axes = gridAxes(axes);
  const loraConfig = axes.find((axis) => axis.type === "lora_config");
  const loraWeight = axes.find((axis) => axis.type === "lora_weight");
  if (loraConfig && loraWeight) return { xAxis: loraConfig.type, yAxis: loraWeight.type };
  const xAxis = loraConfig?.type ?? axes[0]?.type ?? "";
  const yAxis = axes.find((axis) => axis.type !== xAxis)?.type ?? "";
  return { xAxis, yAxis };
}

function normalizeGridState(axes: ComparisonAxis[], state?: Partial<ComparisonGridState>): ComparisonGridState {
  axes = gridAxes(axes);
  const defaults = chooseGridAxes(axes);
  const hasAxis = (type: string) => axes.some((axis) => axis.type === type);
  const xAxis = hasAxis(state?.xAxis ?? "") ? state?.xAxis ?? defaults.xAxis : defaults.xAxis;
  const requestedYAxis = state && Object.hasOwn(state, "yAxis") ? state.yAxis : undefined;
  const yAxis = axes.length < 2 || requestedYAxis === ""
    ? ""
    : requestedYAxis && hasAxis(requestedYAxis) && requestedYAxis !== xAxis
      ? requestedYAxis
      : defaults.yAxis !== xAxis ? defaults.yAxis : axes.find((axis) => axis.type !== xAxis)?.type ?? "";
  const sliceAxes = axes.filter((axis) => axis.type !== xAxis && axis.type !== yAxis);
  const slices = Object.fromEntries(sliceAxes.map((axis) => {
    const current = state?.slices?.[axis.type];
    return [axis.type, axis.values.some((value) => value.value_id === current) ? current ?? "" : axis.values[0]?.value_id ?? ""];
  }));
  const preferredHorizontal = sliceAxes.find((axis) => axis.type === "seed")?.type ?? sliceAxes[0]?.type ?? "";
  const horizontalAxis = sliceAxes.some((axis) => axis.type === state?.horizontalAxis)
    ? state?.horizontalAxis ?? preferredHorizontal
    : preferredHorizontal;
  const preferredVertical = sliceAxes.find((axis) => axis.type !== horizontalAxis)?.type ?? "";
  const verticalAxis = sliceAxes.some((axis) => axis.type === state?.verticalAxis && axis.type !== horizontalAxis)
    ? state?.verticalAxis ?? preferredVertical
    : preferredVertical;
  return { xAxis, yAxis, slices, horizontalAxis, verticalAxis };
}

export default function ComparisonExperimentsView({ resources, runtimeTasks = { tasks: [], history: [] } }: {
  resources: ComparisonResources | null; runtimeTasks?: TaskCollection;
}) {
  const [inputs, setInputs] = useState<ComparisonInput[]>([]);
  const [draftVersion, setDraftVersion] = useState(0);
  const draftEpoch = useRef(0);
  const [selectedForDelete, setSelectedForDelete] = useState<string[]>([]);
  const [deleting, setDeleting] = useState(false);
  const { notify } = useFeedback();
  const [experiments, setExperiments] = useState<ComparisonRecord[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [showCreate, setShowCreate] = useState(false);
  const [experimentSearch, setExperimentSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [starting, setStarting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [formError, setFormError] = useState("");
  const [selectedLoraIds, setSelectedLoraIds] = useState<string[]>([]);
  const [loraApplicationMode, setLoraApplicationMode] = useState<"append" | "replace_character">("append");
  const [loraTargetCharacterId, setLoraTargetCharacterId] = useState("");
  const [loraPickerIds, setLoraPickerIds] = useState<string[] | null>(null);
  const [weightText, setWeightText] = useState("0.8");
  const [characterWeightText, setCharacterWeightText] = useState("");
  const [includeLoraBaseline, setIncludeLoraBaseline] = useState(true);
  const [seedText, setSeedText] = useState("");
  const [cfgText, setCfgText] = useState("");
  const [gridStates, setGridStates] = useState<Record<string, ComparisonGridState>>({});
  const [imagePreview, setImagePreview] = useState<ComparisonImagePreview | null>(null);
  const detailRef = useRef<HTMLDivElement>(null);
  const runtimeComparisonIds = useRef<Set<string>>(new Set());
  const readEpoch = useRef(0);

  const base = "/api/comparison-experiments";
  const loraOptions = useMemo(() => (resources?.models ?? []).filter((model) => model.kind === "lora" && model.relative_path), [resources]);

  const loraItems = useMemo(() => loraOptions.map(loraResourceItem), [loraOptions]);
  const compatibleLoraItems = useMemo(() => loraItems.filter(item => {
    const model = loraOptions.find(model => model.id === item.id)!;
    return inputs.every(input => loraMatchesProfile(model, input.render.profile));
  }), [loraItems, loraOptions, inputs]);
  const commonCharacters = useMemo(() => {
    if (!inputs.length) return [];
    return [...new Set(inputs[0].loras.filter(lora => lora.kind === "character").map(lora => lora.owner).filter((id): id is string => Boolean(id)))].filter(id => inputs.every(input => input.loras.some(lora => lora.kind === "character" && lora.owner === id))).map(id => ({ id, name: id }));
  }, [inputs]);
  useEffect(() => {
    setLoraTargetCharacterId((current) => commonCharacters.some((character) => character.id === current)
      ? current
      : commonCharacters[0]?.id ?? "");
  }, [commonCharacters]);

  const loadExperiments = useCallback(async (quiet = false) => {
    const epoch = readEpoch.current;
    if (!quiet) setLoading(true);
    else setRefreshing(true);
    try {
      const result = await responseJson<{ experiments: ComparisonRecord[] }>(await fetch(base, { headers: { accept: "application/json" } }));
      if (epoch === readEpoch.current) setExperiments(result.experiments ?? []);
    } catch (error) {
      notify({ kind: "error", message: `读取对比实验失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [base, notify]);

  const loadDetail = useCallback(async (id: string, { select = true } = {}) => {
    const epoch = readEpoch.current;
    if (select) { setImagePreview(null); setSelectedId(id); }
    try {
      const result = await responseJson<{ experiment: ComparisonRecord }>(await fetch(`${base}/${encodeURIComponent(id)}`, { headers: { accept: "application/json" } }));
      if (epoch === readEpoch.current) setExperiments((current) => mergeRecord(current, result.experiment));
    } catch (error) {
      notify({ kind: "error", message: `读取对比实验详情失败：${error instanceof Error ? error.message : String(error)}` });
    }
  }, [base, notify]);

  useEffect(() => { void loadExperiments(); }, [loadExperiments]);

  const selected = experiments.find((record) => record.id === selectedId) ?? null;
  const visibleExperiments = useMemo(() => [...experiments]
    .sort((a, b) => Date.parse(b.manifest.created_at) - Date.parse(a.manifest.created_at) || b.id.localeCompare(a.id))
    .filter((record) => (statusFilter === "all" || record.status.status === statusFilter)
      && record.id.toLocaleLowerCase().includes(experimentSearch.trim().toLocaleLowerCase())), [experiments, experimentSearch, statusFilter]);
  const currentRuntimeTasks = runtimeTasks.tasks.filter((task) => task.purpose === "comparison");
  const selectedGlobalTask = selected ? currentRuntimeTasks.find((task) => task.id === selected.id) ?? null : null;
  const selectedGlobalSignature = selectedGlobalTask ? `${selectedGlobalTask.status}:${JSON.stringify(selectedGlobalTask.item_counts)}` : null;

  useEffect(() => {
    if (!selected) return;
    setGridStates((current) => current[selected.id] ? current : {
      ...current,
      [selected.id]: normalizeGridState(selected.manifest.axes),
    });
  }, [selected?.id]);

  function updateGridState(update: Partial<ComparisonGridState>) {
    if (!selected) return;
    setGridStates((current) => {
      const state = normalizeGridState(selected.manifest.axes, { ...current[selected.id], ...update });
      return { ...current, [selected.id]: state };
    });
  }

  // Discovery and cadence belong to App's single /api/tasks poller. Unknown
  // IDs are hydrated here; a disappearing active ID gets one final read so
  // the comparison page can show its archived terminal result.
  useEffect(() => {
    const plan = comparisonRuntimeSyncPlan(experiments, runtimeTasks, null, runtimeComparisonIds.current);
    runtimeComparisonIds.current = new Set(plan.currentIds);
    const idsToRead = [...new Set([...plan.unknownIds, ...plan.disappearedIds])];
    if (plan.unknownIds.length) void loadExperiments(true);
    for (const id of idsToRead) void loadDetail(id, { select: false });
  }, [experiments, loadDetail, loadExperiments, runtimeTasks]);

  useEffect(() => {
    if (!selected || !selectedGlobalSignature) return;
    void loadDetail(selected.id, { select: false });
  }, [loadDetail, selected?.id, selectedGlobalSignature]);

  function resetDraft() {
    draftEpoch.current += 1;
    setDraftVersion(draftEpoch.current);
    setInputs([]);
    setSelectedLoraIds([]);
    setLoraApplicationMode("append");
    setLoraTargetCharacterId("");
    setLoraPickerIds(null);
    setWeightText("0.8");
    setCharacterWeightText("");
    setIncludeLoraBaseline(true);
    setSeedText("");
    setCfgText("");
    setFormError("");
  }

  async function createAndStart() {
    setFormError("");
    if (!inputs.length) { setFormError("请至少添加一个测试输入"); return; }
    if (selectedLoraIds.length && loraApplicationMode === "replace_character" && !commonCharacters.some((character) => character.id === loraTargetCharacterId)) {
      setFormError("替换角色模式要求测试输入共同包含一个角色");
      return;
    }
    try {
      const weights = selectedLoraIds.length ? parseNumberList(weightText, "LoRA 权重") : [];
      if (selectedLoraIds.length && !weights.length) throw new Error("选择 LoRA 后请填写至少一个权重");
      const characterWeights = parseNumberList(characterWeightText, "角色 LoRA 权重");
      const seeds = parseNumberList(seedText, "Seed");
      const cfgs = parseNumberList(cfgText, "CFG");
      const selectedLoras = loraOptions.filter((model) => selectedLoraIds.includes(model.id));
      const axes: ComparisonAxis[] = [axisValues("input", inputs.map(input => input.id), inputs.map(input => input.label))];
      if (selectedLoras.length) {
        axes.push({ type: "lora_config", values: [
          ...(includeLoraBaseline ? [{ value_id: "baseline", label: "基线", value: "baseline" }] : []),
          ...selectedLoras.map((model) => ({ value_id: model.id, label: model.name, value: model.id })),
        ] });
        if (characterWeights.length) axes.push(axisValues("character_lora_weight", characterWeights));
        axes.push(axisValues("lora_weight", weights));
      }
      if (seeds.length) axes.push(axisValues("seed", seeds));
      if (cfgs.length) axes.push(axisValues("cfg", cfgs));
      setStarting(true);
      const id = `comparison-${Date.now().toString(36)}`;
      const loraSources = selectedLoras.map((model) => model.repository_record || model.local_record
        ? { id: model.id, kind: "resource", resource_id: model.id }
        : { id: model.id, kind: "raw", relative_path: model.relative_path });
      const created = await responseJson<{ experiment: ComparisonRecord }>(await fetch(base, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json" },
        body: JSON.stringify({
          id,
          axes, inputs,
          ...(loraSources.length ? { lora_sources: loraSources } : {}),
          ...(loraSources.length ? { include_lora_baseline: includeLoraBaseline } : {}),
          ...(loraSources.length && loraApplicationMode === "replace_character"
            ? { lora_application: { mode: "replace_character", target_character_id: loraTargetCharacterId } }
            : {}),
        }),
      }));
      setExperiments((current) => mergeRecord(current, created.experiment));
      setSelectedId(id);
      const started = await responseJson<{ experiment: ComparisonRecord }>(await fetch(`${base}/${encodeURIComponent(id)}/start`, { method: "POST", headers: { accept: "application/json" } }));
      const running = { ...started.experiment, status: { ...started.experiment.status, status: "running" as const } };
      setExperiments((current) => mergeRecord(current, running));
      setSelectedId(id);
    } catch (error) {
      setFormError(error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }

  async function retrySelected() {
    if (!selected || retrying) return;
    setRetrying(true);
    try {
      const result = await responseJson<{ experiment: ComparisonRecord }>(await fetch(`${base}/${encodeURIComponent(selected.id)}/retry`, { method: "POST", headers: { accept: "application/json" } }));
      setExperiments(current => mergeRecord(current, result.experiment));
    } catch (error) {
      notify({ kind: "error", message: `补跑失败：${error instanceof Error ? error.message : String(error)}` });
    } finally {
      setRetrying(false);
    }
  }


  const selectedLoraSet = new Set(selectedLoraIds);
  /** 缺失资产不禁止配置，只在开始实验时阻止。 */
  const missingSelectedLoras = loraOptions.filter((model) => selectedLoraSet.has(model.id) && model.status !== "available");
  const previewAxes = [
    `${inputs.length} 个测试输入`,
    selectedLoraSet.size ? `${selectedLoraSet.size + (includeLoraBaseline ? 1 : 0)} 个 LoRA 配置` : "基线 LoRA 配置",
    selectedLoraSet.size && characterWeightText.trim() ? `${characterWeightText.split(",").filter((value) => value.trim()).length} 个角色 LoRA 权重` : null,
    selectedLoraSet.size ? `${weightText.split(",").filter((value) => value.trim()).length || 1} 个权重` : null,
    seedText.trim() ? `${seedText.split(",").filter((value) => value.trim()).length} 个 Seed` : "共享随机 Seed",
    cfgText.trim() ? `${cfgText.split(",").filter((value) => value.trim()).length} 个 CFG` : "沿用输入 CFG",
  ].filter(Boolean);
  const cellCountPreview = previewAxes.reduce((count, item) => {
    const match = /^(\d+)/.exec(String(item));
    return count * (match ? Number(match[1]) : 1);
  }, 1);

  const selectedGrid = selected ? (() => {
    const state = normalizeGridState(selected.manifest.axes, gridStates[selected.id]);
    const xAxis = selected.manifest.axes.find((axis) => axis.type === state.xAxis);
    const yAxis = selected.manifest.axes.find((axis) => axis.type === state.yAxis);
    const sliceAxes = selected.manifest.axes.filter((axis) => axis.values.length > 1 && axis.type !== state.xAxis && axis.type !== state.yAxis);
    const statusById = new Map(selected.status.cells.map((cell) => [cell.id, cell]));
    const cells = selected.manifest.cells.map((cell) => ({ ...cell, ...statusById.get(cell.id) }));
    const cellFor = (xValue: string, yValue: string) => cells.find((cell) => {
      if (cell.axis_values[state.xAxis] !== xValue) return false;
      if (state.yAxis && cell.axis_values[state.yAxis] !== yValue) return false;
      return sliceAxes.every((axis) => cell.axis_values[axis.type] === state.slices[axis.type]);
    });
    const axisLabel = (type: string, valueId: string) => {
      const axis = selected.manifest.axes.find((item) => item.type === type);
      return axis?.values.find((value) => value.value_id === valueId)?.label ?? valueId;
    };
    const xValues = xAxis?.values ?? [];
    const yValues = yAxis?.values ?? [{ value_id: "", label: "结果" }];
    return { state, xAxis, yAxis, sliceAxes, cells, cellFor, axisLabel, xValues, yValues };
  })() : null;

  function handleGridKeyDown(event: KeyboardEvent) {
    if (!selected || !selectedGrid || imagePreview || event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;
    const target = event.target as HTMLElement;
    if (target.closest("input, select, textarea, [contenteditable='true']")) return;
    const axisType = event.key === "ArrowLeft" || event.key === "ArrowRight"
      ? selectedGrid.state.horizontalAxis
      : event.key === "ArrowUp" || event.key === "ArrowDown"
        ? selectedGrid.state.verticalAxis
        : "";
    if (!axisType) return;
    const axis = selected.manifest.axes.find((item) => item.type === axisType);
    if (!axis) return;
    const current = selectedGrid.state.slices[axisType] ?? axis.values[0]?.value_id;
    const index = axis.values.findIndex((value) => value.value_id === current);
    if (index < 0) return;
    const delta = event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 1;
    const next = axis.values[index + delta];
    event.preventDefault();
    if (!next) return;
    updateGridState({ slices: { ...selectedGrid.state.slices, [axisType]: next.value_id } });
  }

  useEffect(() => {
    if (!selected) return;
    window.addEventListener("keydown", handleGridKeyDown);
    return () => window.removeEventListener("keydown", handleGridKeyDown);
  });
  useEffect(() => { detailRef.current?.focus({ preventScroll: true }); }, [selected?.id]);

  const gridAxisOptions = gridAxes(selected?.manifest.axes ?? []);
  const selectedExperimentIndex = visibleExperiments.findIndex(record => record.id === selectedId);

  async function deleteExperiments(ids: string[]) {
    if (!ids.length || !window.confirm(`删除 ${ids.length} 个实验及其全部图片、运行记录和相关拼图？`)) return;
    setDeleting(true);
    try {
      await responseJson(await fetch(base, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify({ ids }) }));
      readEpoch.current += 1;
      setExperiments(current => current.filter(record => !ids.includes(record.id))); setSelectedForDelete([]);
      if (ids.includes(selectedId)) { setSelectedId(""); setImagePreview(null); }
    } catch (error) { notify({ kind: "error", message: String(error) }); } finally { setDeleting(false); }
  }
  async function stopSelected() {
    if (!selected) return;
    try { await responseJson(await fetch(`${base}/${encodeURIComponent(selected.id)}/cancel`, { method: "POST" })); await loadDetail(selected.id); }
    catch (error) { notify({ kind: "error", message: String(error) }); }
  }
  async function startSelected() {
    if (!selected) return;
    setStarting(true);
    try { await responseJson(await fetch(`${base}/${encodeURIComponent(selected.id)}/start`, { method: "POST" })); await loadDetail(selected.id); }
    catch (error) { notify({ kind: "error", message: String(error) }); } finally { setStarting(false); }
  }
  return <div>
    <section className="utility-page comparison-experiments-page">
      <WorkspaceHeader title="对比实验" description="查看实验结果，比较不同生成条件" actions={<><button type="button" className="button" onClick={() => void loadExperiments(true)} disabled={loading || refreshing}>{refreshing ? "刷新中…" : "刷新"}</button><button type="button" className="button button--primary" aria-expanded={showCreate} onClick={() => setShowCreate(!showCreate)}>{showCreate ? "收起新建" : "新建实验"}</button></>} />
      <div className="comparison-form-actions"><button type="button" className="button" onClick={() => setSelectedForDelete(visibleExperiments.filter(record => !currentRuntimeTasks.some(task => task.id === record.id)).map(record => record.id))}>选择当前可清理实验</button><button type="button" className="button" disabled={deleting || !selectedForDelete.length} onClick={() => void deleteExperiments(selectedForDelete)}>清理所选（{selectedForDelete.length}）</button></div>
      <section hidden={!showCreate} className="settings-card comparison-experiment-form">
        <header><div><h3>新建实验</h3><p>先选择比较轴，确认生成数量后开始。</p></div><button type="button" className="button" disabled={starting} onClick={resetDraft}>清空重置</button></header>
        <ComparisonInputEditor key={draftVersion} value={inputs} onChange={value => { if (draftEpoch.current === draftVersion) setInputs(value); }} disabled={starting} models={loraOptions} />
        <fieldset><legend>LoRA 配置（可选）</legend><div className="comparison-page-picker comparison-lora-picker">
          <div className="comparison-page-picker__header"><div className="comparison-page-picker__count"><b>已选择 {selectedLoraSet.size} 个 LoRA</b><span>{selectedLoraSet.size ? "选中的 LoRA 会加入比较轴" : "不选择则只比较测试输入、Seed 或 CFG"}</span></div><div className="comparison-page-picker__actions"><button type="button" className="button button--quiet" disabled={!selectedLoraSet.size} onClick={() => setSelectedLoraIds([])}>清空</button><button type="button" className="button" onClick={() => setLoraPickerIds([...selectedLoraIds])}>选择 LoRA</button></div></div>
          <div className="comparison-selected-loras">{loraItems.filter(item => selectedLoraSet.has(item.id)).map(item => <article key={item.id}><div><b>{item.name}</b><small>{item.purpose} · {item.summary || item.originalName || item.relativePath}</small></div><ResourceDetailsButton item={item} /><button type="button" className="button button--quiet" aria-label={"移除 " + item.name} onClick={() => setSelectedLoraIds(ids => ids.filter(id => id !== item.id))}>移除</button></article>)}</div>
          {loraPickerIds !== null && <Modal size="workspace" title="选择 LoRA" subtitle="按测试输入的底座筛选；未登记资源的兼容性尚未确认。" onClose={() => setLoraPickerIds(null)} ariaLabel="选择 LoRA"
            footer={<><button type="button" className="button" onClick={() => setLoraPickerIds(null)}>取消</button><button type="button" className="button button--primary" onClick={() => { setSelectedLoraIds(loraPickerIds); setLoraPickerIds(null); }}>确认选择（{loraPickerIds.length}）</button></>}>
            <div className="lora-picker-body"><ResourcePicker items={compatibleLoraItems} selection={{ ids: loraPickerIds, onChange: setLoraPickerIds }} /></div>
          </Modal>}
        </div><div className="comparison-form-grid"><label><span>LoRA 应用方式</span><select value={loraApplicationMode} disabled={!selectedLoraSet.size} onChange={(event) => setLoraApplicationMode(event.target.value as "append" | "replace_character")}><option value="append">额外叠加</option><option value="replace_character">替换角色</option></select><small>替换模式一次替换一个角色，其他角色和画风 LoRA 保持不变。</small></label>{loraApplicationMode === "replace_character" && selectedLoraSet.size > 0 && <label><span>目标角色</span><select value={loraTargetCharacterId} disabled={!commonCharacters.length} onChange={(event) => setLoraTargetCharacterId(event.target.value)}>{commonCharacters.map((character) => <option key={character.id} value={character.id}>{character.name}</option>)}</select><small>{commonCharacters.length ? "仅显示所有已选输入共同包含的角色。" : "已选输入没有共同角色，无法开始替换实验。"}</small></label>}<label><span>测试 LoRA 权重</span><input value={weightText} disabled={!selectedLoraSet.size} onChange={(event) => setWeightText(event.target.value)} placeholder="例如 0.6, 0.8, 1" /><small>只控制当前追加或替换的测试 LoRA。</small></label><label><span>角色 LoRA 权重</span><input value={characterWeightText} disabled={!selectedLoraSet.size} onChange={(event) => setCharacterWeightText(event.target.value)} placeholder="留空沿用输入角色权重" /><small>填写后要求每个测试输入恰好包含一个角色 LoRA。</small></label><label className="comparison-checkbox-field"><span>无测试 LoRA 基线</span><span className="comparison-checkbox-control"><input type="checkbox" checked={includeLoraBaseline} disabled={!selectedLoraSet.size} onChange={(event) => setIncludeLoraBaseline(event.target.checked)} /><b>{includeLoraBaseline ? "包含基线" : "不包含基线"}</b></span><small>关闭后只展开已选择的 LoRA，不生成无风格基线。</small></label><label><span>Seed</span><input value={seedText} onChange={(event) => setSeedText(event.target.value)} placeholder="留空使用整组共享随机 Seed" /><small>填写逗号分隔值才创建 Seed 轴。</small></label><label><span>CFG</span><input value={cfgText} onChange={(event) => setCfgText(event.target.value)} placeholder="留空沿用输入 CFG" /><small>填写逗号分隔值才创建 CFG 轴。</small></label></div></fieldset>
        <div className="comparison-experiment-summary"><div><span>当前组合</span><b>{previewAxes.join(" · ")}</b></div><div><span>预计生成</span><b>{cellCountPreview} 张</b></div></div>
        {formError && <p className="comparison-form-error" role="alert">{formError}</p>}
        {missingSelectedLoras.length > 0 && <p className="comparison-form-error" role="alert">所选 LoRA 暂不可用：{missingSelectedLoras.map((model) => `${model.name}（${resourceStatusLabel(model.status)}）`).join("、")}，恢复可用后才能开始。</p>}
        <footer className="comparison-form-actions"><button type="button" className="button button--primary" disabled={starting || !inputs.length || missingSelectedLoras.length > 0 || (selectedLoraSet.size > 0 && loraApplicationMode === "replace_character" && (!commonCharacters.length || !loraTargetCharacterId))} onClick={() => void createAndStart()}>{starting ? "准备并开始…" : "开始实验"}</button></footer>
      </section>
      <section className="settings-card comparison-experiment-list">
        <header><div><h3>已有实验 <small>{experiments.length}</small></h3><p>{loading ? "正在读取…" : "按创建时间从新到旧排列，打开结果查看对比。"}</p></div></header>
        <div className="comparison-list-filters">
          <label><span>搜索实验</span><input type="search" placeholder="输入实验名称" value={experimentSearch} onChange={(event) => setExperimentSearch(event.target.value)} /></label>
          <label><span>实验状态</span><select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value)}><option value="all">全部状态</option>{Object.entries(statusLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
          <span className="comparison-muted">显示 {visibleExperiments.length} / {experiments.length} 个</span>
        </div>
        {!loading && !visibleExperiments.length && <div className="empty-card">{experiments.length ? "没有匹配的实验，请调整搜索或状态。" : "还没有对比实验，点击“新建实验”开始。"}</div>}
        {visibleExperiments.map((record) => { const current = progress(record); return <article key={record.id} className={selectedId === record.id ? "is-selected" : ""}>
          <input type="checkbox" aria-label={`选择清理 ${record.id}`} checked={selectedForDelete.includes(record.id)} onChange={event => setSelectedForDelete(current => event.target.checked ? [...current, record.id] : current.filter(id => id !== record.id))} />
          <div><b title={record.id}>{record.id}</b><small>{new Date(record.manifest.created_at).toLocaleString()}</small><div className="comparison-axis-tags">{record.manifest.axes.filter(axis => axis.values.length > 1).map(axis => <span key={axis.type}>{axisOptionLabel(axis)}</span>)}{record.manifest.axes.every(axis => axis.values.length === 1) && <span>全部条件固定</span>}</div></div>
          <span className={`comparison-status comparison-status--${record.status.status}`}>{statusLabels[record.status.status]}</span><span>{current.done} / {current.total} 张</span>
          <button type="button" className="button button--quiet" onClick={() => void loadDetail(record.id)}>查看结果</button>
        </article>; })}
      </section>
      {selected && selectedGrid && <Modal size="workspace" title={selected.id} subtitle={`${statusLabels[selected.status.status]} · ${progress(selected).done} / ${progress(selected).total} 张`} onClose={() => setSelectedId("")} dismissible={!imagePreview} className="comparison-detail-modal" ariaLabel={`对比实验详情：${selected.id}`}><div className="comparison-experiment-detail" ref={detailRef} tabIndex={-1} onChange={event => { if (event.target instanceof HTMLSelectElement) detailRef.current?.focus({ preventScroll: true }); }}>
        {(selected.retry_available ?? ["failed", "incomplete"].includes(selected.status.status)) && <div><button type="button" className="button button--primary" disabled={retrying} onClick={() => void retrySelected()}>{retrying ? "准备补跑…" : "补跑未完成项"}</button><p>沿用本实验输入，保留已完成图片。</p></div>}
        <nav className="comparison-experiment-pager" aria-label="切换实验">
          <span>{selectedExperimentIndex + 1 || "—"} / {visibleExperiments.length} 个实验 · 最新在前</span>
          <button type="button" className="button" disabled={selectedExperimentIndex <= 0} onClick={() => void loadDetail(visibleExperiments[selectedExperimentIndex - 1].id)}>上一个实验</button>
          <button type="button" className="button" disabled={selectedExperimentIndex < 0 || selectedExperimentIndex >= visibleExperiments.length - 1} onClick={() => void loadDetail(visibleExperiments[selectedExperimentIndex + 1].id)}>下一个实验</button>
        </nav>
        <div className="comparison-form-actions">{selected.status.status === "queued" && !selected.status.started_at && <button type="button" className="button" disabled={starting} onClick={() => void startSelected()}>开始已保存实验</button>}{currentRuntimeTasks.some(task => task.id === selected.id) && <button type="button" className="button" onClick={() => void stopSelected()}>停止实验</button>}<button type="button" className="button" disabled={deleting || currentRuntimeTasks.some(task => task.id === selected.id)} onClick={() => void deleteExperiments([selected.id])}>删除实验</button></div><dl className="comparison-axis-overview" aria-label="实验条件">
          {selected.manifest.axes.map(axis => <div key={`${selected.id}-${axis.type}`} className={axis.values.length === 1 ? "is-fixed" : ""}>
            <dt>{comparisonAxisLabel(axis.type)} <b>{axis.values.length === 1 ? "固定" : `x${axis.values.length}`}</b></dt>
            <dd>{axis.values.map(value => <span key={value.value_id}>{value.label}</span>)}</dd>
          </div>)}
        </dl>
        <section className="comparison-view-settings">
          <header><h3>对比布局</h3><span>当前显示 {selectedGrid.xValues.length} 列 × {selectedGrid.yValues.length} 行，共 {selectedGrid.xValues.length * selectedGrid.yValues.length} / {selected.manifest.cells.length} 张</span></header>
          <div className="comparison-grid-controls">
            <label><span>列维度</span><select aria-label="列维度" value={selectedGrid.state.xAxis} onChange={(event) => updateGridState({ xAxis: event.target.value, ...(event.target.value === selectedGrid.state.yAxis ? { yAxis: selectedGrid.state.xAxis } : {}) })}>{gridAxisOptions.map((axis) => <option key={axis.type} value={axis.type}>{axisOptionLabel(axis)}</option>)}</select></label>
            <button type="button" className="button comparison-swap" disabled={!selectedGrid.state.yAxis} onClick={() => updateGridState({ xAxis: selectedGrid.state.yAxis, yAxis: selectedGrid.state.xAxis })}>交换行列</button>
            <label><span>行维度</span><select aria-label="行维度" value={selectedGrid.state.yAxis} disabled={gridAxisOptions.length < 2} onChange={(event) => updateGridState({ yAxis: event.target.value })}><option value="">不使用（单行查看）</option>{gridAxisOptions.filter((axis) => axis.type !== selectedGrid.state.xAxis).map((axis) => <option key={axis.type} value={axis.type}>{axisOptionLabel(axis)}</option>)}</select></label>
            <button type="button" className="button" onClick={() => { setGridStates(current => ({ ...current, [selected.id]: normalizeGridState(selected.manifest.axes) })); }}>恢复默认布局</button>
          </div>
        </section>
        <section className="comparison-view-settings comparison-browse-settings">
          <header><h3>筛选与切换</h3><span>{selectedGrid.sliceAxes.length ? "选择后可直接按方向键切换。" : "当前变体已全部展开。"}</span>{!selectedGrid.sliceAxes.length && selectedGrid.state.yAxis && <button type="button" className="button" onClick={() => updateGridState({ yAxis: "" })}>改为单行浏览</button>}</header>
          <div className="comparison-slice-controls">{selectedGrid.sliceAxes.map((axis) => {
            const index = axis.values.findIndex(value => value.value_id === selectedGrid.state.slices[axis.type]);
            const selectValue = (value: string) => updateGridState({ slices: { ...selectedGrid.state.slices, [axis.type]: value } });
            return <div className="comparison-slice" key={axis.type}><label><span><span>{comparisonAxisLabel(axis.type)} {selectedGrid.state.horizontalAxis === axis.type ? <kbd>← →</kbd> : selectedGrid.state.verticalAxis === axis.type ? <kbd>↑ ↓</kbd> : null}</span><small>{index + 1} / {axis.values.length}</small></span><select value={selectedGrid.state.slices[axis.type] ?? ""} onChange={event => selectValue(event.target.value)}>{axis.values.map((value, i) => <option key={value.value_id} value={value.value_id}>{i + 1}. {value.label}</option>)}</select></label><div><button type="button" className="button" aria-label={`上一个${comparisonAxisLabel(axis.type)}`} disabled={index <= 0} onClick={() => selectValue(axis.values[index - 1].value_id)}>←</button><button type="button" className="button" aria-label={`下一个${comparisonAxisLabel(axis.type)}`} disabled={index >= axis.values.length - 1} onClick={() => selectValue(axis.values[index + 1].value_id)}>→</button></div></div>;
          })}</div>
          {selectedGrid.sliceAxes.length > 1 && <div className="comparison-grid-controls comparison-keyboard-settings">
            <label><span>左右键切换</span><select aria-label="左右键切换" disabled={!selectedGrid.sliceAxes.length} value={selectedGrid.state.horizontalAxis} onChange={(event) => updateGridState({ horizontalAxis: event.target.value })}>{!selectedGrid.sliceAxes.length && <option value="">无可切换维度</option>}{selectedGrid.sliceAxes.map((axis) => <option key={axis.type} value={axis.type}>{axisOptionLabel(axis)}</option>)}</select></label>
            <label><span>上下键切换</span><select aria-label="上下键切换" disabled={selectedGrid.sliceAxes.length < 2} value={selectedGrid.state.verticalAxis} onChange={(event) => updateGridState({ verticalAxis: event.target.value })}>{selectedGrid.sliceAxes.length < 2 && <option value="">无可切换维度</option>}{selectedGrid.sliceAxes.filter((axis) => axis.type !== selectedGrid.state.horizontalAxis).map((axis) => <option key={axis.type} value={axis.type}>{axisOptionLabel(axis)}</option>)}</select></label>
          </div>}
        </section>
        <p className="comparison-grid-hint">点击图片放大查看。宽网格可左右滚动；固定条件不参与行列选择。</p>
        <div className="comparison-result-grid" style={{ "--comparison-grid-columns": selectedGrid.xValues.length } as CSSProperties} tabIndex={0}>
          <div className="comparison-result-grid__corner"><span><em>列</em>{comparisonAxisLabel(selectedGrid.xAxis?.type ?? "结果")}</span>{selectedGrid.yAxis && <span><em>行</em>{comparisonAxisLabel(selectedGrid.yAxis.type)}</span>}</div>
          {selectedGrid.xValues.map((value) => <div className="comparison-result-grid__axis comparison-result-grid__axis--x" key={`x-${value.value_id}`}>{value.label}</div>)}
          {selectedGrid.yValues.map((yValue) => <div className="comparison-result-grid__row" key={`row-${yValue.value_id}`}>
            <div className="comparison-result-grid__axis comparison-result-grid__axis--y">{yValue.label}</div>
            {selectedGrid.xValues.map((xValue) => {
              const cell = selectedGrid.cellFor(xValue.value_id, yValue.value_id);
              const status = cell?.status ?? "queued";
              const pageLabel = cell ? selectedGrid.axisLabel("input", cell.axis_values.input ?? "") || `第 ${cell.ordinal + 1} 格` : "";
              const imageLabel = cell ? selected.manifest.axes.map(axis => `${comparisonAxisLabel(axis.type)}：${selectedGrid.axisLabel(axis.type, cell.axis_values[axis.type])}`).join(" · ") : "";
              const imageSrc = cell ? `${base}/${encodeURIComponent(selected.id)}/results/${cell.id}.png` : "";
              return <article className={`comparison-result-grid__cell comparison-result-grid__cell--${status}`} key={`${yValue.value_id}-${xValue.value_id}`}>
                {cell && <small>{pageLabel}</small>}
                <span>{status === "completed" ? "已完成" : status === "running" ? "生成中" : status === "incomplete" || status === "failed" ? "失败" : status === "cancelled" ? "已取消" : "待生成"}</span>
                {cell?.error?.message && <p className="comparison-form-error">{cell.error.message}</p>}
                {status === "completed" && cell && <ComparisonGridImage src={imageSrc} label={imageLabel} onOpen={() => setImagePreview({ src: imageSrc, alt: imageLabel, footer: imageLabel })} />}
              </article>;
            })}
          </div>)}
        </div>
      </div></Modal>}
      {imagePreview && <ZoomableImageLightbox src={imagePreview.src} alt={imagePreview.alt} footer={<span>{imagePreview.footer}</span>} onClose={() => setImagePreview(null)} />}
    </section>
  </div>;
}
