import {PromptTextArea} from '../../SourcePromptEditor';
import type {ModelPageEditorProps} from '../types';
import type {PagePromptDraft} from './types';

export function H3PageEditor({page,prompt,onChange,disabled}:ModelPageEditorProps<PagePromptDraft>) {
  return <><PromptTextArea ariaLabel={`${page.title} 本页 Prompt`} rows={4} value={prompt.text??''} disabled={disabled} placeholder="动作描述，可使用中文" onChange={text=>onChange({...prompt,text})}/>
    <label>时长（秒）<input type="number" min={3} max={15} step="any" disabled={disabled} value={prompt.duration??5} onChange={e=>onChange({...prompt,duration:Number(e.target.value)})}/></label>
    <label>尺寸<select disabled={disabled} value={prompt.quality??'standard'} onChange={e=>onChange({...prompt,quality:e.target.value as 'preview'|'standard'})}><option value="preview">低分辨率</option><option value="standard">标准尺寸</option></select></label>
    <label>采样步数<input type="number" min={8} max={50} disabled={disabled} value={prompt.steps??20} onChange={e=>onChange({...prompt,steps:Number(e.target.value)})}/></label>
    <label><input type="checkbox" disabled={disabled} checked={prompt.loop??false} onChange={e=>onChange({...prompt,loop:e.target.checked})}/>循环生成</label><small>24 fps · 无音频 · 无超分；输入图在单页导入</small></>;
}
