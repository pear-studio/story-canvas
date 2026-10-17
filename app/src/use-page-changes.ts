import {useLayoutEffect,useRef} from 'react';
type PageChanges={dirty:boolean;save:()=>Promise<boolean>};
const editors=new Map<string,()=>PageChanges>();
export function currentPageSave(){return [...editors.values()].at(-1)?.().save;}
export function usePageChanges(identity:string,changes:PageChanges,enabled=true){
  const latest=useRef(changes);latest.current=changes;
  useLayoutEffect(()=>{if(!enabled)return;const read=()=>latest.current;editors.set(identity,read);return()=>{if(editors.get(identity)===read)editors.delete(identity);};},[identity,enabled]);
}
