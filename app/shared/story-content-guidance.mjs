export const SCENE_DESCRIPTION_CHARACTER_LIMIT = 20;
export const NARRATION_CHARACTER_LIMIT = 200;

export function countStoryCharacters(text) {
  return [...text].length;
}

export function storyContentWarnings(narrative) {
  const warnings = [];
  const sceneLength = countStoryCharacters(narrative.scene_description);
  if (sceneLength > SCENE_DESCRIPTION_CHARACTER_LIMIT) warnings.push({
    code: "scene_description_too_long",
    field: "scene_description",
    actual_length: sceneLength,
    max_length: SCENE_DESCRIPTION_CHARACTER_LIMIT,
    message: `画面内容为 ${sceneLength} 字，超过创作规范上限 ${SCENE_DESCRIPTION_CHARACTER_LIMIT} 字；请精简，不影响保存或生成。`,
  });
  return warnings;
}
