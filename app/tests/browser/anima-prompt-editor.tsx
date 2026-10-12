import "../../src/WorkbenchPageEditor.css";
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { PromptFragmentEditor, ReadonlyPromptFragmentEditor, type PromptFragment } from "../../src/PromptFragmentEditor";
import "../../src/styles.css";
import { createPromptDraftFragment, persistFragmentList } from "../../src/prompt-fragment-draft";

function Harness() {
  const referenceMode = new URLSearchParams(location.search).has("references");
  const readonly = new URLSearchParams(location.search).has("readonly");
  const roleMode = new URLSearchParams(location.search).has("roles") || referenceMode;
  const cameraMode = new URLSearchParams(location.search).has("camera");
  const [fragments, setFragments] = useState<Record<string, PromptFragment[]>>({
    setting: [{ id: "probe", prompt_type: "custom_description", prompt_text: "quiet hallway under dim lights with a window and soft evening shadows" }],
    ...(cameraMode ? { camera: [{ id: "token-123456789abc", prompt_type: "custom_description" as const, prompt_text: "from side" }] } : {}),
    ...(roleMode ? { person: referenceMode ? [
      { id: "person-probe", prompt_type: "danbooru" as const, prompt_text: "long_hair", weight: 1.2, role: "alice" },
      { id: "other-role", prompt_type: "danbooru" as const, prompt_text: "blue_eyes", role: "bob" },
      { id: "same-role", prompt_type: "danbooru" as const, prompt_text: "smile", role: "alice" },
    ] : [{ id: "person-probe", prompt_type: "danbooru" as const, prompt_text: "long_hair", weight: 1.2 }],  } : {}),
  });
  return <div id="host" style={{ width: 1000, marginTop: 320 }}>
    {readonly ? <ReadonlyPromptFragmentEditor categories={[{ id: "person", label: "人物" }]} scope="page" fragments={fragments} /> :
    <PromptFragmentEditor categories={[...(roleMode ? [{ id: "person", label: "人物" }] : []), { id: "setting", label: "场景" }, ...(cameraMode ? [{ id: "camera", label: "镜头" }] : []), ...(referenceMode ? [{ id: "avoid", label: "避免" }] : [])]} roles={roleMode ? [{ id: "alice", label: "甲", color: "#549870" }, { id: "bob", label: "乙", color: "#548098" }] : undefined} scope="page" fragments={fragments} onChange={setFragments}
      createFragment={() => ({ ...createPromptDraftFragment(), prompt_type: "custom_description" })} />}
    <output>{JSON.stringify(fragments)}</output>
    {cameraMode && <pre id="persisted-camera">{JSON.stringify(persistFragmentList(fragments.camera))}</pre>}
  </div>;
}
createRoot(document.getElementById("root")!).render(<Harness />);
