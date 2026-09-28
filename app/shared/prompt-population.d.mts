export type PopulationKind = 'girls' | 'boys' | 'others';
export const populationKinds: PopulationKind[];
export const populationTags: Array<{prompt_text:string;kind:PopulationKind;minimum:number}>;
export function populationText(value:unknown):string;
export function populationTag(value:unknown):{prompt_text:string;kind:PopulationKind;minimum:number}|null;
export function isPopulationControl(value:unknown):boolean;
export function validatePopulation(prompt:unknown,options?:{setting?:boolean}):string[];

export const populationInputs:string[];
