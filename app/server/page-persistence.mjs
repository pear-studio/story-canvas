import { randomBytes } from 'node:crypto';
import { ApiError } from './http-support.mjs';
import { modelAdapter } from './model-adapters.mjs';
import { mapModelPrompts, promptModelEntries } from './model-prompts.mjs';
import { prepareStoryPageNarrativeForPersistence, validateStoryPageNarrativeDocument } from './story-files.mjs';
import { assertPagePromptSourceVersions, validatePagePromptInheritance } from './prompt-source-context.mjs';

// 网页整页提交与 Agent 局部提交共享归一化/继承校验；布局清理仍由各自事务范围决定。
export function preparePageContent(edited, baseline, errorCode) {
  let value;
  try {
    value = prepareStoryPageNarrativeForPersistence(edited, {baselineNarrative:baseline,createDialogueId:occupied=>{
      for (;;) {const id=`dialogue-${randomBytes(6).toString('hex')}`;if(!occupied.includes(id))return id;}
    }});
  } catch (error) {if (error instanceof TypeError) throw new ApiError(422,errorCode,[error.message]);throw error;}
  if (value.page_kind !== baseline.page_kind) throw new ApiError(422,'page_kind_immutable');
  const errors=validateStoryPageNarrativeDocument(value);
  if(errors.length)throw new ApiError(422,errorCode,errors);
  return value;
}
export function preparePagePrompts(edited, baseline) {
  const previous=new Map(promptModelEntries(baseline));
  return mapModelPrompts(edited,(input,modelId)=>modelAdapter(modelId).preparePagePrompt(input,{
    baselinePrompt:previous.get(modelId),createFragmentId:()=>`token-${randomBytes(6).toString('hex')}`,
  }));
}
export async function validatePagePromptSources(directory, options, errorCode) {
  const sources=await assertPagePromptSourceVersions(directory,options);
  const errors=await validatePagePromptInheritance(directory,{...options,sources});
  if(errors.length)throw new ApiError(422,errorCode,errors);
}
