import {resolveLetteringLayout} from './lettering-layout';
import {letteringPreset,type LetteringItem,type LetteringStyle} from './lettering';
import type {WorkbenchDialogueDraft} from './WorkbenchPageEditor';
import {resolveHeart,heartSettings} from './HeartLettering';
export const translationFont='SVTranslation';
let measure:CanvasRenderingContext2D|null=null;
function wrap(text:string,width:number,font:number,locale:string){
  // 与共享样式 lettering-text 的字重一致。
  measure??=document.createElement('canvas').getContext('2d')!;measure.font=`650 ${font}px ${translationFont}`;
  const result:string[]=[];
  for(const paragraph of text.split('\n')){let line='';const tokens=locale==='en'?paragraph.match(/\S+\s*|\s+/g)??['']:Array.from(paragraph);
    for(const token of tokens){if(line&&measure.measureText(line+token).width>width){
      if(locale==='ja'&&/^[、。，．！？：；）］｝」』】〉》]/.test(token)&&Array.from(line).length>1){const characters=Array.from(line),last=characters.pop()!;result.push(characters.join(''));line=last;}
      else if(!/^[、。，．！？：；）］｝」』】〉》]/.test(token)){result.push(line.trimEnd());line='';}
    }
      if(measure.measureText(token).width>width){for(const char of token){if(line&&measure.measureText(line+char).width>width){result.push(line.trimEnd());line='';}line+=char;}}else line+=token;
    }result.push(line.trimEnd());
  }return result;
}
export function resolveTranslatedLettering(line:WorkbenchDialogueDraft,source:WorkbenchDialogueDraft,item:LetteringItem,style:LetteringStyle,dimensions:{width:number;height:number},locale:string){
  if(line.mode==='heart'){
    const original=resolveHeart(source.text,item,dimensions,style.font_size),base=heartSettings(item,style.font_size);
    let settings={...base},result=resolveHeart(line.text,{...item,heart:settings},dimensions,style.font_size,translationFont,source.text);
    const ratio=Math.min(1,original.box.w*1.1/Math.max(result.box.w,.001),original.box.h*1.1/Math.max(result.box.h,.001));
    settings={...base,font_size:base.font_size*Math.max(.85,ratio)};
    result=resolveHeart(line.text,{...item,heart:settings},dimensions,style.font_size,translationFont,source.text);
    return {...result,fontSize:style.font_size,budgetExceeded:result.box.w>original.box.w*1.1+.001||result.box.h>original.box.h*1.1+.001};
  }
  const preset=letteringPreset(source as Parameters<typeof letteringPreset>[0],style);
  const original=resolveLetteringLayout({text:source.text,direction:preset.direction,kind:preset.kind,fontSize:style.font_size,canvasWidth:dimensions.width,canvasHeight:dimensions.height,box:item.box});
  // 中文竖排转为横排时交换像素宽高，保持相近面积，避免译文挤成单字符列。
  if(preset.direction==='vertical'){const width=original.box.h*dimensions.height,height=original.box.w*dimensions.width;original.box.w=width/dimensions.width;original.box.h=height/dimensions.height;}
  const width=Math.min(original.box.w*1.1,Math.max(.001,1-item.box.x))*dimensions.width;
  let fontSize=style.font_size,lines:string[]=[],height=0;
  for(const ratio of [1,.95,.9,.85]){fontSize=style.font_size*ratio;const font=fontSize*dimensions.width/1024;const inset=font*(preset.kind==='plain'?.18:.45);
    lines=wrap(line.text,Math.max(font,width-2*inset),font,locale);height=lines.length*font*1.3+font*(preset.kind==='plain'?.36:.84);
    if(height<=original.box.h*dimensions.height*1.1)break;
  }
  measure!.font=`650 ${fontSize*dimensions.width/1024}px ${translationFont}`;
  const actualWidth=Math.max(...lines.map(line=>measure!.measureText(line).width))+(fontSize*dimensions.width/1024)*(preset.kind==='plain'?.36:.9);
  return {box:{...item.box,w:width/dimensions.width,h:height/dimensions.height},lines,columns:[],fontSize,overflow:height>(1-item.box.y)*dimensions.height||actualWidth>width+1,budgetExceeded:height>original.box.h*dimensions.height*1.1};
}
