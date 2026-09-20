import { cameraFragmentIndex, createCameraFragment, type CameraSettings } from "../shared/camera-prompt.mjs";
import type { PromptFragment } from "./PromptFragmentEditor";

export function applyCameraDraft(draft: Record<string, PromptFragment[]>, settings: CameraSettings, create: () => PromptFragment) {
  const output = createCameraFragment(settings);
  const camera = draft.camera ?? [];
  const index = cameraFragmentIndex(camera);
  if (!output.description) return index < 0 ? draft : { ...draft, camera: camera.filter((_, position) => position !== index) };
  const fragment: PromptFragment = { id: index >= 0 ? camera[index].id : create().id, prompt_type: "custom_description", prompt_text: output.description, camera_settings: output.camera_settings };
  return { ...draft, camera: index < 0 ? [...camera, fragment] : camera.map((item, position) => position === index ? fragment : item) };
}
