type Fragment = { id?: string; tag?: string; description?: string; prompt_text?: string; weight?: number; enabled?: boolean; character_id?: string; role?: string; inheritance_key?: string; inheritance_source?: string };
type Prompt = Record<'population' | 'person' | 'setting' | 'camera' | 'avoid', Fragment[]>;
type Adjustments = Record<string, { weight?: number; enabled?: boolean }>;
export const inheritanceCategories: string[];
export function promptText(fragment: Fragment): string;
export function promptWord(text: string): string;
export function characterSource(id: string, variant: string): string;
export function sceneSource(id: string, variant: string): string;
export function emptyCategories(): Prompt;
export function applyInheritedPrompt(prompt: Partial<Prompt>, adjustments?: Adjustments): Prompt;
export function inheritedOverrideCount(prompt: Partial<Prompt>, adjustments?: Adjustments): {overridden: number; total: number};
export function effectivePromptEntries(prompt: Partial<Prompt>, category: keyof Prompt, adjustments?: Adjustments): Array<{ fragment: Fragment; index: number }>;
export function variantPrompt(identity: { prompt: Prompt }, variant: { prompt: Prompt; identity_overrides?: Adjustments }): Prompt;

export function adjustmentKey(fragment: Fragment, category?: string): string;
export function validateAdjustments(value: unknown, label?: string, options?: { availableKeys?: Iterable<string>; baselineAdjustments?: Adjustments; layers?: Array<'identity' | 'variant'> }): string[];
