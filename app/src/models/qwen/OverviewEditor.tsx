import {PromptTextArea} from '../../SourcePromptEditor';
import type {ModelOverviewEditorProps} from '../types';
import type {PagePromptDraft} from './types';

export function QwenOverviewEditor({page,prompt,onChange,disabled}:ModelOverviewEditorProps<PagePromptDraft>) {
  return <PromptTextArea ariaLabel={`${page.title} 本页 Prompt`} rows={4} value={prompt.text??''} disabled={disabled} placeholder="本页画面描述，可留空" onChange={text=>onChange({...prompt,text})}/>;
}
