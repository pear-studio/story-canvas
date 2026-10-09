import { mediaReviewHint } from './media-review.mjs';
// 等待只投影操作身份与本机读取路径；完整元数据仍由 task.results 提供。
export function compactWaitImage(row, identity) {
  const keys=['candidate_id','page_key'];
  const result={...identity,...Object.fromEntries(keys.filter(k=>row[k]!==undefined).map(k=>[k,row[k]]))};
  if(row.candidate_id===undefined && row.id!==undefined)result.id=row.id;
  if(row.media_kind==='video')return {...result,media_kind:'video',absolute_review:row.absolute_review??null,...(row.absolute_video?{absolute_video:row.absolute_video}:{})};
  return {...result,absolute_file:row.absolute_file??null};
}
// 图片投影有独立预算；查询失败不覆盖已确认的生成状态。
export async function waitResultImages(result,{request,signal}) {
  const deadline=AbortSignal.timeout(5000);
  const readSignal=signal?AbortSignal.any([signal,deadline]):deadline;
  const images=[],more=[],errors=[];
  let fetched=0;
  for(const task of result.tasks) {
    if(!task.terminal || task.error || (task.task?.item_counts?.available===0))continue;
    if(task.changed===false && !task.task)continue;
    const args={project_id:task.project_id,task_id:task.task_id,purpose:task.purpose??'candidate'};
    const next={operation:'task.results',args};
    if(readSignal.aborted || fetched>=4 || images.length>=12){more.push(next);continue;}
    fetched++;
    try {
      const route=`/api/tasks/${encodeURIComponent(args.project_id)}/${encodeURIComponent(args.task_id)}/results?purpose=${args.purpose}`;
      const response=await request(route,{signal:readSignal});
      const rows=response.value.images;
      if(!Array.isArray(rows))throw new Error('图片结果格式无效');
      const selected=rows.slice(0,12-images.length);
      images.push(...selected.map(row=>compactWaitImage(row,args)));
      if(selected.length<rows.length)more.push({...next,args:{...args,offset:selected.length}});
    }catch(error){more.push(next);errors.push({...args,message:error.message});}
  }
  return {...(images.length?{images,read_with:images.some(row=>row.media_kind==='video')?mediaReviewHint:'read_image(file_path=absolute_file)'}:{}),...(more.length?{more_images:more}:{}),...(errors.length?{image_errors:errors}:{})};
}
