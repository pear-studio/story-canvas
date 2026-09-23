import { loraResourceCatalogItem, rawLoraCatalogItem, type LoraResourceDefinition, type ResourceCatalogItem, type ResourcePreviewImage } from "./ResourceCatalog";

export type GlobalModelResource = {
  id: string;
  name: string;
  kind: string;
  architecture_family: "sd15" | "sdxl" | "anima" | "qwen-image-2-1" | "sd3" | "flux" | "other";
  prompt_family?: string;
  filename: string;
  relative_path: string;
  sha256?: string;
  size_bytes?: number;
  source?: string;
  registered: boolean;
  local_record?: boolean;
  repository_record?: boolean;
  status: string;
  reason?: string | null;
  preview?: { images: ResourcePreviewImage[] } | null;
  lora_metadata?: {
    name_zh?: string;
    summary_zh?: string;
    purpose?: LoraResourceDefinition["purpose"];
    architecture?: LoraResourceDefinition["architecture"];
    base_models?: LoraResourceDefinition["base_models"];
    activation?: LoraResourceDefinition["activation"];
    recommended_generation?: LoraResourceDefinition["recommended_generation"];
    description?: string;
    usage_notes?: string;
    source?: LoraResourceDefinition["source"];
  };
  usage?: { profiles?: Array<{ id: string; name: string }>; projects?: Array<{ id: string; title: string }> };
};

export function loraResourceItem(model: GlobalModelResource): ResourceCatalogItem {
  if (!model.registered || !model.lora_metadata) return rawLoraCatalogItem({ id: model.id, name: model.name, relative_path: model.relative_path, sha256: model.sha256 ?? "", size_bytes: model.size_bytes ?? 0, status: model.status });
  const metadata = model.lora_metadata;
  const resource: LoraResourceDefinition = {
    id: model.id,
    name: model.name,
    name_zh: metadata.name_zh,
    summary_zh: metadata.summary_zh,
    purpose: metadata.purpose,
    file: { relative_path: model.relative_path, sha256: model.sha256 ?? "", size_bytes: model.size_bytes ?? 0 },
    architecture: metadata.architecture ?? { family: model.architecture_family, prompt_family: model.prompt_family ?? "unknown" },
    base_models: metadata.base_models ?? [],
    activation: metadata.activation ?? { trigger_words: [], tags: [] },
    recommended_generation: metadata.recommended_generation ?? { weight: { default: null, minimum: null, maximum: null, status: "untested" }, status: "untested" },
    description: metadata.description ?? "",
    usage_notes: metadata.usage_notes ?? "",
    source: metadata.source ?? { type: "unknown" },
    previews: [],
    examples: [],
  };
  return { ...loraResourceCatalogItem({ resource, status: model.status, size_bytes: model.size_bytes, repository_record: model.repository_record }), previewImages: model.preview?.images ?? [] };
}

export function loraMatchesProfile(model: GlobalModelResource, profile: { architecture_family?: string }) {
  return !model.registered || !profile.architecture_family || model.architecture_family === profile.architecture_family;
}
