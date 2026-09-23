import { createRoot } from "react-dom/client";
import { useState } from "react";
import ComparisonExperimentsView from "../../src/ComparisonExperimentsView";
import { FeedbackProvider } from "../../src/feedback";
import type { TaskCollection } from "../../src/runtime-status";
import type { GlobalModelResource } from "../../src/global-resource-catalog";
import "../../src/styles.css";

const models: GlobalModelResource[] = [
  { id: "flat", name: "Anime Flat Style", kind: "lora", architecture_family: "anima", prompt_family: "anima", filename: "flat.safetensors", relative_path: "loras/flat.safetensors", status: "available", registered: true, repository_record: true, lora_metadata: { name_zh: "平涂动漫画风", summary_zh: "引入平涂动漫插画风格。", purpose: "画风", activation: { tags: ["upstream-style"], trigger_words: [] } } },
  { id: "muscle", name: "Muscle Slider", kind: "lora", architecture_family: "anima", prompt_family: "anima", filename: "muscle.safetensors", relative_path: "loras/muscle.safetensors", status: "available", registered: true, repository_record: true, lora_metadata: { name_zh: "肌肉感调节", summary_zh: "调节人物肌肉的发达程度。", purpose: "外观调节" } },
  { id: "raw", name: "checkpoint-400", kind: "lora", architecture_family: "other", filename: "raw.safetensors", relative_path: "loras/training/raw.safetensors", status: "available", registered: false },
  { id: "veloria", name: "Veloria · Qwen-Image-2.1", kind: "lora", architecture_family: "qwen-image-2-1", filename: "veloria.safetensors", relative_path: "loras/veloria.safetensors", status: "available", registered: true, repository_record: true, lora_metadata: { name_zh: "维洛莉亚", summary_zh: "Qwen 角色 LoRA", purpose: "角色" } },
];

function Harness() {
  const [runtimeTasks, setRuntimeTasks] = useState<TaskCollection>({ tasks: [], history: [] });
  return <FeedbackProvider><button id="simulate-progress" onClick={() => setRuntimeTasks({ tasks: [{ id: 'confirm-cup-strict-v2', project_id: null, project_title: '测试', purpose: 'comparison', status: 'running', created_at: null, progress: null, pages: [], item_counts: { total: 20, available: 10, skipped: 0, discarded: 0, running: 1, queued: 9, failed: 0 } }], history: [] })}>模拟后台进度更新</button><ComparisonExperimentsView resources={{ models }} runtimeTasks={runtimeTasks} /></FeedbackProvider>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
