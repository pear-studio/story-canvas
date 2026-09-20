import { getRenderPromptDictionary } from "./prompt-dictionary-service.mjs";

export async function loadPromptDictionaryForRender(localConfig, root) {
  return getRenderPromptDictionary(localConfig, root);
}
