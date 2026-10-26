import type {ReferenceEntry} from '../../ReferenceLibrary';
import type {PageLoraFields} from '../prompt-common';

export type PagePrompt = PageLoraFields & {
  text:string;
  composition:'standalone';
  duration:number;
  loop:boolean;
  quality:'preview'|'standard';
  steps:number;
  reference_images?:Array<ReferenceEntry & {purpose?:string}>;
};
export type PagePromptDraft = Partial<PagePrompt>;
