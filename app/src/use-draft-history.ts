import {useCallback,useEffect,useLayoutEffect,useReducer,useRef} from 'react';

// 文本连续输入和一次拖动合为一步；历史只在当前编辑身份内保留。
export function useDraftHistory<T>(value:T,restore:(value:T)=>void,identity:string,enabled=true){
  const [,render]=useReducer(count=>count+1,0);
  const state=useRef({identity,current:structuredClone(value),past:[] as T[],future:[] as T[],changedAt:0});
  const latest=useRef(restore);latest.current=restore;
  const signature=JSON.stringify(value);
  useLayoutEffect(()=>{
    const history=state.current;
    if(history.identity!==identity){state.current={identity,current:structuredClone(value),past:[],future:[],changedAt:0};render();return;}
    if(JSON.stringify(history.current)===signature)return;
    const now=performance.now();
    if(!history.past.length||now-history.changedAt>400)history.past.push(history.current);
    if(history.past.length>100)history.past.shift();
    history.current=structuredClone(value);history.future=[];history.changedAt=now;render();
  },[signature,identity]);
  const step=useCallback((redo:boolean)=>{const history=state.current,source=redo?history.future:history.past,target=source.pop();if(target===undefined)return;(redo?history.past:history.future).push(history.current);history.current=structuredClone(target);history.changedAt=0;latest.current(structuredClone(target));render();},[]);
  const undo=useCallback(()=>step(false),[step]),redo=useCallback(()=>step(true),[step]);
  const checkpoint=useCallback(()=>{state.current.changedAt=-Infinity;},[]);
  useEffect(()=>{
    if(!enabled)return;
    const key=(event:KeyboardEvent)=>{
      if(event.defaultPrevented||event.isComposing||!(event.ctrlKey||event.metaKey)||event.altKey||!['z','y'].includes(event.key.toLowerCase()))return;
      if(event.target instanceof Element&&event.target.closest('input,textarea,select,[contenteditable="true"]'))return;
      if(document.querySelector('[aria-modal="true"]'))return;
      event.preventDefault();if(event.key.toLowerCase()==='y'||event.shiftKey)redo();else undo();
    };
    window.addEventListener('keydown',key);return()=>window.removeEventListener('keydown',key);
  },[enabled,undo,redo]);
  return {undo,redo,checkpoint,canUndo:state.current.past.length>0,canRedo:state.current.future.length>0};
}
