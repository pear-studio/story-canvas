export const SCENE_DESCRIPTION_CHARACTER_LIMIT: 20;
export const NARRATION_CHARACTER_LIMIT: 200;
export type StoryContentWarning = {
  code: "scene_description_too_long";
  field: "scene_description";
  actual_length: number;
  max_length: number;
  message: string;
};
export function countStoryCharacters(text: string): number;
export function storyContentWarnings(narrative: { scene_description: string }): StoryContentWarning[];
