type Source = {identity?:object;variant?:object;missing?:string};
export function cleanPageCharacterInput<T extends object>(input:T, beforeCharacters:Array<{character_id:string;variant_id:string}>, afterCharacters:Array<{character_id:string;variant_id:string}>, loraScope?:{beforeSources:Record<string,Source>;afterSources:Record<string,Source>;styleLoras?:Array<{filename:string}>}):T;
