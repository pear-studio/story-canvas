import type {ReactNode} from 'react';
import {PageLoraEditor} from './PageLoraEditor';
import type {ModelPageEditorProps} from './types';

/** 共享页面操作；模型自己决定编辑器、标题位置及已展示的设定 LoRA。 */
export function PagePromptFrame({children,settingFilenames=[],...props}:ModelPageEditorProps & {children:ReactNode;settingFilenames?:string[]}) {
  return <div className="compact-prompt-editor">{children}<PageLoraEditor settingFilenames={settingFilenames} projectId={props.projectId} page={props.page} prompt={props.prompt} onChange={props.onChange} disabled={props.disabled}/></div>;
}
