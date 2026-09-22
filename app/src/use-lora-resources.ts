import { useEffect, useState } from "react";

import { responseJson } from "./api-response";
import type { LoraResourceDefinition, LoraResourceEntry, RawLoraResource } from "./ResourceCatalog";

export type LoraResourceList = { resources: LoraResourceEntry[]; raw: RawLoraResource[]; errors: unknown[] };
export type LoraCompatibility = { architectureFamily?: string; promptFamily?: string } | null;

type RenderProfileSummaryResponse = {
  current_profile_id: string;
  render_profiles: Array<{ id: string; architecture_family?: string; prompt_family?: string | null }>;
};

/** 与项目生成设置一致：未登记的本机 LoRA 包装成当前基模架构的 synthetic 资源定义。 */
export function rawLoraResourceDefinition(raw: RawLoraResource, compatibility: LoraCompatibility): LoraResourceDefinition {
  return {
    id: raw.id,
    name: raw.name,
    file: { relative_path: raw.relative_path, sha256: raw.sha256, size_bytes: raw.size_bytes },
    architecture: { family: compatibility?.architectureFamily ?? "other", prompt_family: compatibility?.promptFamily ?? "universal" },
    base_models: [],
    activation: { trigger_words: [], tags: [] },
    recommended_generation: { weight: { default: 1, minimum: null, maximum: null, status: "untested" }, clip_skip: null, sampler: null, scheduler: null, steps: null, cfg: null, status: "untested" },
    description: "未登记的本机 LoRA",
    usage_notes: "",
    source: { type: "local_file" },
    previews: [],
    examples: [],
  };
}

/** 读取 library LoRA 资源列表与当前项目基模的兼容性（架构家族 + Prompt 家族），供 LoRA 选择器使用。 */
export function useProjectLoraResources(projectId: string) {
  const [state, setState] = useState<{ list: LoraResourceList | null; compatibility: LoraCompatibility; error: string | null }>({ list: null, compatibility: null, error: null });
  useEffect(() => {
    let cancelled = false;
    setState({ list: null, compatibility: null, error: null });
    Promise.all([
      fetch("/api/lora-resources", { headers: { accept: "application/json" } }).then((response) => responseJson<LoraResourceList>(response)),
      fetch(`/api/projects/${encodeURIComponent(projectId)}/render-profile`, { headers: { accept: "application/json" } }).then((response) => responseJson<RenderProfileSummaryResponse>(response)),
    ]).then(([list, profile]) => {
      if (cancelled) return;
      const current = profile.render_profiles.find((entry) => entry.id === profile.current_profile_id) ?? null;
      setState({
        list,
        compatibility: current ? { architectureFamily: current.architecture_family, promptFamily: current.prompt_family ?? undefined } : null,
        error: null,
      });
    }).catch((cause) => {
      if (!cancelled) setState({ list: null, compatibility: null, error: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { cancelled = true; };
  }, [projectId]);
  return state;
}
