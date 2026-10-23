import {collectFinishedExport,collectFinishedSelections,finishedSelectionLabel,prepareFinishedExport,exportFinishedLocal,requireExportMode} from './finished-export.mjs';
import {sendFinishedExport} from './finished-export-download.mjs';
import { requireLetteringLocale } from './page-translation-document.mjs';
import { randomUUID } from 'node:crypto';

import { ApiError, readJsonBody, sendJson } from "./http-support.mjs";
import {optimizeFinishedGif} from './finished-gif.mjs';
import { deleteFinishedPage, listFinishedJobs, planFinishedBatch, prepareFinishedPage, readFinishedPages, readFinishedRecord, requireFinishedVariant, runFinishedBatch, runFinishedPage } from "./finished-pages.mjs";

const activeBatches = new Set();
// 只保留短期文件清单；媒体仍从磁盘流式读取，不缓存整包。
const preparedExports = new Map();

export async function handleFinishedRequest({ request, response, decodedPath, projectRoot, config, readFacts, mutateDerived, mutateTargetFacts, sendOperation }) {
  const match = /^\/api\/projects\/([^/]+)\/finished(?:\/(output-batch|output|export-local|export|jobs|optimize-gif))?\/?$/.exec(decodedPath);
  if (!match) return false;
  const projectId = match[1];
  if(request.method==='POST'&&match[2]==='optimize-gif') {
    const value=await readJsonBody(request);
    sendOperation(200,await optimizeFinishedGif({repositoryRoot:projectRoot,projectId,value,readFacts,mutateTargetFacts}));
    return true;
  }
  if (request.method === 'GET' && match[2] === 'export') {
    const ticket = new URL(request.url, 'http://local').searchParams.get('ticket');
    const prepared = preparedExports.get(ticket);
    if (!prepared || prepared.projectRoot !== projectRoot || prepared.projectId !== projectId) throw new ApiError(404, 'finished_export_expired');
    preparedExports.delete(ticket);
    clearTimeout(prepared.timer);
    await sendFinishedExport(response, prepared);
    return true;
  }
  if (request.method === "DELETE" && !match[2]) {
    const value = await readJsonBody(request);
    sendOperation(200, await mutateTargetFacts(projectId, ({ projectDirectory }) => deleteFinishedPage(projectDirectory, value)));
    return true;
  }
  if (request.method === "GET" && match[2] === "jobs") {
    sendOperation(200, await mutateDerived(projectId, async ({ projectDirectory }) => ({ jobs: await listFinishedJobs(projectDirectory) })));
    return true;
  }
  if (request.method === "GET" && !match[2]) {
    const params = new URL(request.url, "http://local").searchParams,page_id=params.get('page_id'),locale=requireLetteringLocale(params.get('locale')??'zh');
    sendOperation(200, await readFacts(projectId, ({ projectDirectory }) => readFinishedPages(projectRoot, projectId, projectDirectory, { page_id,locale,variant:requireFinishedVariant(params.get('variant')??'lettered'),mode:requireExportMode(params.get('mode')??'standard') })));
    return true;
  }
  if (request.method === "POST" && match[2] === "output-batch") {
    const value = await readJsonBody(request);
    if (activeBatches.has(projectId)) throw new ApiError(409, "finished_batch_running");
    const planned = await mutateDerived(projectId, async ({ projectDirectory }) => ({ directory: projectDirectory, plan: await planFinishedBatch(projectRoot, projectId, projectDirectory, { chapter_id: value?.chapter_id || null, force: value?.force === true,locale:requireLetteringLocale(value?.locale) }) }));
    const { directory, plan } = planned.value;
    if (!plan.targets.length) {
      sendOperation(200, planned, { queued: 0, skipped: plan.skipped });
      return true;
    }
    activeBatches.add(projectId);
    // 使用实际监听端口，避免 Host 头或代理地址成为后台浏览器的目标。
    const origin = `http://127.0.0.1:${request.socket.localPort}`;
    void runFinishedBatch({ repositoryRoot: projectRoot, projectId, directory, targets: plan.targets, config, origin, mutateDerived, mutateTargetFacts })
      .catch(error => console.error("[story-canvas] 成品批量输出失败", error))
      .finally(() => activeBatches.delete(projectId));
    sendOperation(202, planned, { queued: plan.targets.length, skipped: plan.skipped });
    return true;
  }
  if (request.method === "POST" && match[2] === "output") {
    const value = await readJsonBody(request);
    const result = await mutateDerived(projectId, async ({ projectDirectory }) => ({ directory: projectDirectory, prepared: await prepareFinishedPage(projectRoot, projectId, projectDirectory, value) }));
    const { directory, prepared } = result.value;
    // 使用实际监听端口，避免 Host 头或代理地址成为后台浏览器的目标。
    const origin = `http://127.0.0.1:${request.socket.localPort}`;
    void runFinishedPage({ repositoryRoot: projectRoot, projectId, directory, prepared, config, origin, mutateTargetFacts })
      .catch(error => console.error("[story-canvas] 成品输出失败", error));
    sendOperation(202, result, { job: prepared.job });
    return true;
  }

  if(request.method==='POST'&&['export','export-local'].includes(match[2])) {
    const value=await readJsonBody(request),local=match[2]==='export-local';
    const controller=new AbortController(),streaming=value.progress===true&&(local||value.prepare===true);
    const disconnected=()=>{if(!response.writableEnded)controller.abort();};response.once('close',disconnected);
    const progress=event=>{if(streaming&&!response.destroyed)response.write(JSON.stringify({progress:event})+'\n');};
    try {
      if(local){
        if(streaming)response.writeHead(200,{'content-type':'application/x-ndjson; charset=utf-8','cache-control':'no-store'});
        const result=await exportFinishedLocal({projectRoot,projectId,value,readFacts,signal:controller.signal,progress});
        if(streaming)response.end(JSON.stringify({result})+'\n');else sendJson(response,200,result);
      }else{
        const selections=value.modes!==undefined||value.editions!==undefined
          ?await collectFinishedSelections({projectRoot,projectId,value,readFacts,signal:controller.signal,progress:()=>{}})
          :[(await readFacts(projectId,({projectDirectory})=>collectFinishedExport(projectRoot,projectId,projectDirectory,value))).value];
        if(streaming)response.writeHead(200,{'content-type':'application/x-ndjson; charset=utf-8','cache-control':'no-store'});
        const prepared=[];
        for(const selection of selections)prepared.push(await prepareFinishedExport(selection,controller.signal,event=>progress({...event,message:finishedSelectionLabel(selection)+' · '+event.message})));
        controller.signal.throwIfAborted();
        const packs=prepared.flatMap(item=>item.packs).map(pack=>({...pack,disposition:'attachment; filename="'+projectId+'.'+(pack.preview?'html':'zip')+"\"; filename*=UTF-8''"+encodeURIComponent(pack.filename).replace(/['()*]/g,char=>'%'+char.charCodeAt(0).toString(16).toUpperCase())}));
        if(value.prepare===true){
          const artifacts=packs.map(pack=>{
            const ticket=randomUUID(),timer=setTimeout(()=>preparedExports.delete(ticket),15*60_000);timer.unref();
            preparedExports.set(ticket,{...pack,projectRoot,projectId,timer});
            return {filename:pack.filename,download_url:'/api/projects/'+encodeURIComponent(projectId)+'/finished/export?ticket='+ticket};
          });
          const result={...artifacts[0],artifacts,warnings:prepared.flatMap(item=>item.warnings.map(w=>finishedSelectionLabel(item)+' · '+w)),volumes:prepared.flatMap(item=>item.volumes),groups:prepared.map(item=>({label:finishedSelectionLabel(item),volumes:item.volumes}))};
          if(streaming)response.end(JSON.stringify({result})+'\n');else sendJson(response,200,result);
        }else{
          if(packs.length!==1)throw new ApiError(409,'finished_export_multiple_parts',['EH 已拆分多个 ZIP，请在网页准备下载，或使用 finished.export.local 保存所有分包']);
          await sendFinishedExport(response,packs[0]);
        }
      }
    }catch(error){
      if(!streaming||!response.headersSent)throw error;
      if(!response.destroyed)response.end(JSON.stringify({error:(error.details?.join?.('；')||error.message)+(error.exportDirectory?'；已完成的文件保留在 '+error.exportDirectory:'')})+'\n');
    }finally{response.off('close',disconnected);}
    return true;
  }
  return false;
}
