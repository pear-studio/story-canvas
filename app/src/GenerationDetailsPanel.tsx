import type { GenerationDetails, PageRenderPromptPart } from "./project-workbench-client";
import { generationPromptSegments } from "./generation-prompt-segments";
import "./GenerationDetailsPanel.css";

type PromptSource = "render_profile" | "lora_trigger" | "character" | "visual" | "avoid";

const promptSourceDefinitions: Array<{ id: PromptSource; label: string }> = [
  { id: "render_profile", label: "模型配置" },
  { id: "lora_trigger", label: "LoRA 触发词" },
  { id: "character", label: "角色设定" },
  { id: "visual", label: "页面 Prompt" },
  { id: "avoid", label: "避免内容" },
];

function promptPartSource(part: PageRenderPromptPart): PromptSource {
  if (part.origin === "render_profile" || part.origin === "prompt_policy" || part.origin === "project_override") return "render_profile";
  if (part.origin === "lora_trigger") return "lora_trigger";
  if (part.origin === "character") return "character";
  if (part.category === "avoid") return "avoid";
  return "visual";
}

function renderPromptParts(parts: PageRenderPromptPart[], text: string, empty: string) {
  if (!text) return empty;
  return generationPromptSegments(text, parts).map(({ text, part }, index) => {
    if (!part) return <span className="generation-prompt-separator" key={index}>{text}</span>;
    const source = promptPartSource(part);
    return <mark className={`generation-prompt-part generation-prompt-part--${source}`} key={index}>{text}</mark>;
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
  const allParts = [...details.prompt.parts.positive, ...details.prompt.parts.negative];
  const usedSources = new Set(allParts.map(promptPartSource));
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
        <article><header><b>Positive</b><span>{details.prompt.positive.length} 字符</span></header><pre>{renderPromptParts(details.prompt.parts.positive, details.prompt.positive, "尚未编译")}</pre></article>
        <article><header><b>Negative</b><span>{details.prompt.negative.length} 字符</span></header><pre>{renderPromptParts(details.prompt.parts.negative, details.prompt.negative, "无")}</pre></article>
      </div>
    </section>
  </div>;
}
