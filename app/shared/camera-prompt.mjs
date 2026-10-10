// 仅保存通用摄影参数；角色关系与自由描述由独立 Prompt 负责。
export const CAMERA_DIRECTIONS=Object.freeze({front:'正面',side:'侧面',back:'背面'});
export const CAMERA_HEIGHTS=Object.freeze({above:'俯视',below:'仰视'});
export const CAMERA_SHOTS=Object.freeze({close_up:'近景',full_body:'全身',wide_shot:'远景'});
export const CAMERA_VIEWS=Object.freeze({pov:'第一人称'});
export const CAMERA_EFFECTS=Object.freeze({backgroundBlur:{label:'背景虚化',word:'blurry_background'},foregroundBlur:{label:'前景虚化',word:'blurry_foreground'},motionLines:{label:'运动线',word:'motion_lines'}});
export const CAMERA_DEFAULTS=Object.freeze({});
export function validateCameraSettings(value) {
 if(!value || typeof value!=='object' || Array.isArray(value)) throw new Error('机位参数必须是对象');
 const enums={direction:CAMERA_DIRECTIONS,height:CAMERA_HEIGHTS,shot:CAMERA_SHOTS,view:CAMERA_VIEWS};
 for(const [key,v] of Object.entries(value)) {
  if(Object.hasOwn(enums,key)){if(v!==null && !Object.hasOwn(enums[key],v))throw new Error('机位参数 '+key+' 枚举无效');}
  else if(Object.hasOwn(CAMERA_EFFECTS,key)){if(v!==null && typeof v!=='boolean')throw new Error('机位参数 '+key+' 必须为布尔值');}
  else throw new Error('未知机位参数 '+key);
 }
 return value;
}
export function normalizeCameraSettings(value) {
 validateCameraSettings(value);
 return Object.fromEntries(Object.entries(value).filter(([,v])=>v!==null && v!==false));
}
export function parseCameraSettings(value) {try{return normalizeCameraSettings(value);}catch{return null;}}
export function cameraPromptEntries(value={}) {
 const settings=normalizeCameraSettings(value), rows=[];
 const add=(field,fragment)=>rows.push({field,fragment});
 // 词库无 from_front；保留明确的自然语言，不用表达不同含义的 facing_viewer 替代。
 if(settings.direction==='front')add('direction',{description:'from front'});
 else if(settings.direction)add('direction',{tag:{side:'from_side',back:'from_behind'}[settings.direction]});
 if(settings.height)add('height',{tag:{above:'from_above',below:'from_below'}[settings.height]});
 if(settings.shot)add('shot',{tag:{close_up:'close-up',full_body:'full_body',wide_shot:'wide_shot'}[settings.shot]});
 if(settings.view)add('view',{tag:'pov'});
 for(const [field,effect] of Object.entries(CAMERA_EFFECTS))if(settings[field])add(field,{tag:effect.word});
 return rows;
}
export function cameraPromptPreview(settings={}) {return cameraPromptEntries(settings).map(({fragment})=>fragment.tag??fragment.description);}
