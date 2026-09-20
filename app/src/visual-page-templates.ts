export type VisualPageTemplate = {
  id: string;
  name: string;
  description?: string;
  category: string;
  applies_to: Array<"story" | "character" | "scene">;
};

export type VisualPageTemplateResource = {
  version: 1;
  categories: Array<{ id: string; name: string }>;
  templates: VisualPageTemplate[];
  errors?: string[];
};

export type VisualPageTemplateSubject = {
  characterId: string;
  variantId: string;
  label: string;
};

export type VisualPageTemplateTarget =
  | { ownerKind: "story"; sequenceId: string; targetLabel: string; afterPageId?: string }
  | { ownerKind: "character"; characterId: string; variantId: string; targetLabel: string; afterPageId?: string }
  | { ownerKind: "scene"; sceneId: string; variantId: string; targetLabel: string; afterPageId?: string };
