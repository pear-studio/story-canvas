import type { GenerationDetails, PromptSection } from "./project-workbench-client";
import { generationPromptSegments } from "./generation-prompt-segments";
import "./GenerationDetailsPanel.css";

type PromptSource = "global" | "character" | "scene" | "attachment" | "page" | "reference" | "rewrite";

const promptSourceDefinitions: Array<{ id: PromptSource; label: string }> = [
  { id: "global", label: "全局" },
  { id: "character", label: "角色" },
  { id: "scene", label: "场景" },
  { id: "attachment", label: "附图用途" },
  { id: "page", label: "本页描述" },
  { id: "reference", label: "参考图用途" },
  { id: "rewrite", label: "优化" },
];

function renderPromptSections(sections: PromptSection[], text: string, empty: string) {
  if (!text) return empty;
  return generationPromptSegments(text, sections).map(({ text: segmentText, part }, index) => {
    if (!part) return <span className="generation-prompt-separator" key={index}>{segmentText}</span>;
    return <mark className={`generation-prompt-part generation-prompt-part--${part.kind}`} key={index}>{segmentText}</mark>;
  });
}

function modelRoleLabel(role: string) {
  if (role === "dit") return "主模型";
  if (role === "text_encoder") return "Text Encoder";
  if (role === "vae") return "VAE";
  return role;
}

function loraName(filename: string) {
  return filename.split(/[\\/]/).at(-1)?.replace(/\.(?:safetensors|ckpt|pt)$/i, "") || filename;
}

function loraKindLabel(kind: string) {
  if (kind === "style") return "风格";
  if (kind === "character") return "角色";
  return kind || "LoRA";
}

function value(value: string | number | null | undefined) {
  return value === null || value === undefined || value === "" ? "—" : value;
}

export function GenerationDetailsPanel({ details }: { details: GenerationDetails }) {
  const sections = details.prompt.sections ?? [];
  const usedSources = new Set(sections.map((section) => section.kind));
  const dimensions = details.parameters?.dimensions;
  const dimensionLabel = dimensions?.width && dimensions?.height
    ? `${dimensions.width} × ${dimensions.height}${details.canvas ? `（${details.canvas}）` : ""}`
    : details.canvas ?? "—";
  return <div className="generation-details">
    <section className="generation-details__section generation-details__configuration" aria-labelledby="generation-configuration-heading">
      <h3 id="generation-configuration-heading">生成配置</h3>
      <div className="generation-details__group" aria-labelledby="generation-parameters-heading">
        <h4 id="generation-parameters-heading">参数</h4>
        <dl className="generation-details__items generation-details__items--parameters">
          <div className="generation-details__item--profile"><dt>配置</dt><dd>{value(details.profile_name)}</dd></div>
          <div className="generation-details__item--dimensions"><dt>尺寸</dt><dd>{dimensionLabel}</dd></div>
          <div><dt>Steps</dt><dd>{value(details.parameters?.steps)}</dd></div>
          <div><dt>CFG</dt><dd>{value(details.parameters?.cfg)}</dd></div>
          <div><dt>采样器</dt><dd><code>{value(details.parameters?.sampler)}</code></dd></div>
          <div><dt>调度器</dt><dd><code>{value(details.parameters?.scheduler)}</code></dd></div>
        </dl>
      </div>

      <div className="generation-details__group" aria-labelledby="generation-models-heading">
        <h4 id="generation-models-heading">模型</h4>
        <div className="generation-details__items generation-details__items--models">
          {details.models.length ? details.models.map((model, index) => <div key={`${model.role}:${model.filename}:${index}`}><span>{modelRoleLabel(model.role)}</span><code title={model.filename}>{model.filename}</code></div>) : <p>没有记录模型。</p>}
        </div>
      </div>

      <div className="generation-details__group" aria-labelledby="generation-loras-heading">
        <h4 id="generation-loras-heading">LoRA</h4>
        <div className="generation-details__items generation-details__items--loras">
          {details.loras.length ? details.loras.map((lora, index) => <div key={`${lora.owner}:${lora.filename}:${index}`}><span>{loraKindLabel(lora.kind)}</span><b title={lora.filename}>{loraName(lora.filename)}</b><small>权重 {value(lora.weight)} · <code title={lora.trigger || "无触发词"}>{lora.trigger || "无触发词"}</code></small></div>) : <p>未加载 LoRA。</p>}
        </div>
      </div>
    </section>

    <section className="generation-details__section generation-details__prompt" aria-labelledby="generation-prompt-heading">
      <header><h3 id="generation-prompt-heading">Prompt</h3>{usedSources.size > 0 && <div className="generation-prompt-sources" aria-label="Prompt 来源">{promptSourceDefinitions.filter((source) => usedSources.has(source.id)).map((source) => <span className={`generation-prompt-source generation-prompt-source--${source.id}`} key={source.id}>{source.label}</span>)}</div>}</header>
      <div className="generation-details__prompts">
        <article><header><b>Positive</b><span>{details.prompt.positive.length} 字符</span></header><pre>{renderPromptSections(sections, details.prompt.positive, "尚未编译")}</pre></article>
        {details.prompt.negative && <article><header><b>Negative</b><span>{details.prompt.negative.length} 字符</span></header><pre>{details.prompt.negative}</pre></article>}
      </div>
    </section>
  </div>;
}
