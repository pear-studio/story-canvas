export type Lora = {filename:string;sha256:string;weight:number;trigger?:string;enabled?:boolean};
export type LoraOverrides = Record<string,{weight?:number;enabled?:boolean}>;
export function mergeInheritedLoras(inherited?:Lora[],local?:Lora[],overrides?:LoraOverrides):Lora[];
export function settingLoras(identity?:{lora?:Lora|null},variant?:{loras?:Lora[];lora_overrides?:LoraOverrides}):Lora[];
export function validateLoraOverrides(value:unknown,label?:string):string[];
