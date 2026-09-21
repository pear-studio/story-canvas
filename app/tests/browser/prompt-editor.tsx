import "../../src/WorkbenchPageEditor.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PromptFragmentEditor, type PromptFragment } from "../../src/PromptFragmentEditor";
import "../../src/styles.css";
import { CAMERA_DEFAULTS } from "../../shared/camera-prompt.mjs";
import { persistFragmentList } from "../../src/prompt-fragment-draft";

function Harness() {
  const roleMode = new URLSearchParams(location.search).has("roles");
  const cameraMode = new URLSearchParams(location.search).has("camera");
  const [fragments, setFragments] = useState<Record<string, PromptFragment[]>>({
    setting: [{ id: "probe", prompt_type: "custom_description", prompt_text: "quiet hallway under dim lights with a window and soft evening shadows" }],
    ...(cameraMode ? { camera: [{ id: "token-123456789abc", prompt_type: "custom_description" as const, prompt_text: "from side", camera_settings: { ...CAMERA_DEFAULTS, direction: "side" as const } }] } : {}),
    ...(roleMode ? { person: [{ id: "person-probe", prompt_type: "danbooru" as const, prompt_text: "long_hair", weight: 1.2 }],  } : {}),
  });
  return <div id="host" style={{ width: 1000, marginTop: 320 }}>
    <PromptFragmentEditor categories={[...(roleMode ? [{ id: "person", label: "人物" }] : []), { id: "setting", label: "场景" }, ...(cameraMode ? [{ id: "camera", label: "镜头" }] : [])]} roles={roleMode ? [{ id: "alice", label: "甲", color: "#549870" }, { id: "bob", label: "乙", color: "#548098" }] : undefined} scope="page" fragments={fragments} onChange={setFragments}
      createFragment={() => ({ id: "new", prompt_type: "custom_description", prompt_text: "" })} />
    <output>{JSON.stringify(fragments)}</output>
    {cameraMode && <pre id="persisted-camera">{JSON.stringify(persistFragmentList(fragments.camera))}</pre>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
