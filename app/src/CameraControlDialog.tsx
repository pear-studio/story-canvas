import {useState} from 'react';
import {CAMERA_DIRECTIONS,CAMERA_HEIGHTS,CAMERA_SHOTS,CAMERA_VIEWS,CAMERA_EFFECTS,normalizeCameraSettings,cameraPromptPreview,type CameraSettings} from '../shared/camera-prompt.mjs';
import {Modal} from './Modal';
import './CameraControlDialog.css';
export function CameraControlDialog({cameraSettings,onClose,onApply}:{cameraSettings?:CameraSettings;onClose:()=>void;onApply:(value:CameraSettings)=>void}) {
 const [settings,setSettings]=useState<CameraSettings>(()=>({...cameraSettings}));
 const set=(key:keyof CameraSettings,value:string|boolean|null)=>setSettings(current=>normalizeCameraSettings({...current,[key]:value}));
 return <Modal className="camera-modal" title="机位控制" subtitle="通用摄影参数；人物关系与具体构图另写 Prompt" ariaLabel="机位控制" onClose={onClose} footer={<><button className="button button--quiet" onClick={()=>setSettings({})}>清除机位</button><button className="button" onClick={onClose}>取消</button><button className="button button--primary" onClick={()=>onApply(settings)}>应用到草稿</button></>}>
 <div className="camera-control"><div className="camera-presets">
 {([['direction','方位',CAMERA_DIRECTIONS],['height','高度',CAMERA_HEIGHTS],['shot','景别',CAMERA_SHOTS],['view','观察视角',CAMERA_VIEWS]] as const).map(([field,label,options])=><section key={field}><h3>{label}</h3><div className="camera-toggle-options" role="group" aria-label={label}>{Object.entries(options).map(([value,text])=><button key={value} aria-pressed={settings[field]===value} onClick={()=>set(field,settings[field]===value?null:value)}>{text}</button>)}</div></section>)}
 <section><h3>效果</h3><div className="camera-effect-options">{Object.entries(CAMERA_EFFECTS).map(([key,item])=><button key={key} title={item.word} aria-pressed={Boolean(settings[key as keyof CameraSettings])} onClick={()=>set(key as keyof CameraSettings,!settings[key as keyof CameraSettings])}>{item.label}</button>)}</div></section>
 </div><div className="camera-preview"><span>自动生成 · 只读</span><output aria-label="机位 Prompt 预览">{cameraPromptPreview(settings).join(', ')||'未设置机位；独立镜头 Prompt 保持不变。'}</output></div></div></Modal>;
}
