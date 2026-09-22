import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PromptTextArea } from "../../src/SourcePromptEditor";
import { SettingView } from "../../src/SettingView";
import { FeedbackProvider } from "../../src/feedback";
import type { WorkbenchCharacter } from "../../src/project-workbench-client";
import "../../src/styles.css";

function TextHarness() {
  const [value, setValue] = useState("quiet hallway under dim lights");
  return <div id="host" style={{ width: 1000, marginTop: 40, padding: 24 }}>
    <PromptTextArea ariaLabel="自由文本 Prompt" value={value} onChange={setValue} placeholder="输入整段描述" />
    <output>{JSON.stringify({ value })}</output>
  </div>;
}

const character: WorkbenchCharacter = {
  id: "alice", name: "艾莲", description: "档案描述", profile_sha256: "profile", visual_sha256: "visual", prompt_sha256: "prompt", style: null, pages: [],
  visual: { variants: [{ id: "day", name: "白天" }, { id: "night", name: "夜晚" }] },
  prompt: {
    prompt_name: "艾莲",
    variants: {
      day: { text: "艾莲白天的完整描述", reference_images: [{ id: "ref-11111111-1111-4111-8111-111111111111", file: "reference-11111111.png", title: "正面" }] },
      night: { text: "艾莲夜晚的完整描述" },
    },
  },
};

function SettingHarness() {
  const [current, setCurrent] = useState(character);
  const settingId = new URLSearchParams(location.search).get("variant") ?? "profile";
  return <SettingView kind="character" projectId="test" character={current} initialSettingId={settingId} busy={false}
    onSaved={(replacement) => setCurrent((value) => ({ ...value, ...replacement }))} />;
}

createRoot(document.getElementById("root")!).render(<FeedbackProvider>{location.search.includes("setting") ? <SettingHarness /> : <TextHarness />}</FeedbackProvider>);
