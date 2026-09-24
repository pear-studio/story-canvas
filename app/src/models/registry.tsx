import {AnimaPageEditor} from './anima/PageEditor';
import {QwenPageEditor} from './qwen/PageEditor';
import type {ModelPageEditorProps} from './types';
const models={anima:{PageEditor:AnimaPageEditor},qwen:{PageEditor:QwenPageEditor}};
export const modelChoices=[{id:'anima',label:'Anima Basic',profileId:'anima-base-v1'},{id:'qwen',label:'Qwen-Image-2.1',profileId:'qwen-image-2-1'}] as const;
export function ModelPromptEditor(props:ModelPageEditorProps) {
  const adapter=models[props.page.model_id??'qwen'];
  return <adapter.PageEditor {...props}/>;
}
