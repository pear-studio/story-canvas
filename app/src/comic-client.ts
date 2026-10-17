import type {ComicDocument} from '../shared/comic-layout.mjs';
import {mutateTargetFacts} from './project-write-client';
import {workbenchResponseJson} from './api-response';
export async function comicAction(projectId:string,pageId:string,action:'convert'|'save'|'split'|'restore'|'merge',value:Record<string,unknown>={}) {
  return workbenchResponseJson<{document:ComicDocument;sha256:string;panel_id?:string}>(await mutateTargetFacts(`/api/projects/${encodeURIComponent(projectId)}/workbench/comic/${action}`,{
    method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({page_key:{page_id:pageId},...value}),
  }));
}
export async function planComicMerge(projectId:string,pageId:string,value:Record<string,unknown>){
  return workbenchResponseJson<{sha256:string;sources:{page_id:string;title:string}[]}>(await fetch(`/api/projects/${encodeURIComponent(projectId)}/workbench/comic/merge-plan`,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({page_key:{page_id:pageId},...value})}));
}
