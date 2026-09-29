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
      images.push(...selected.map(row=>({...args,...row})));
      if(selected.length<rows.length)more.push({...next,args:{...args,offset:selected.length}});
    }catch(error){more.push(next);errors.push({...args,message:error.message});}
  }
  return {...(images.length?{images,read_with:'read_image(file_path=absolute_file)'}:{}),...(more.length?{more_images:more}:{}),...(errors.length?{image_errors:errors}:{})};
}
