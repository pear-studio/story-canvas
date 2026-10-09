// 操作参数直接取当前定义，避免工作流入口维护第二份工具契约。
export function videoHelp(actions, availability) {
  const call = (operation, args) => ({ operation, args });
  const project_id = 'demo', page_key = { page_id:'新建动态页返回的page_id' };
  const target = {kind:'page',id:page_key.page_id,model_id:'h3'};
  const steps = [
    {instruction:'已有明确的动态页制作授权后，定位单元及输入候选。candidate.list 返回真实 ID 和图片路径，先查看图片。', calls:[
      call('page.list',{project_id,owner_kind:'story'}),
      call('candidate.list',{project_id,page_key:{page_id:'来源插画页ID'}}),
    ]},
    {instruction:'新建动态页，与插画、文字页混排；owner 只放归属，位置放 args 顶层。',calls:[
      call('page.create',{project_id,owner:{owner_kind:'story',sequence_id:'目标单元ID'},page_kind:'video',after_page_key:{page_id:'前一页ID'}}),
    ]},
    {instruction:'读参考图指纹后导入一张来源候选。target 是新动态页；page_key 是来源插画页。替换已有输入时传 reference.list 返回的 id。',calls:[
      call('reference.list',{project_id,target:{kind:'page',id:page_key.page_id}}),
      call('reference.save',{project_id,target:{kind:'page',id:page_key.page_id},expected_sha256:'reference.list返回的sha256',page_key:{page_id:'来源插画页ID'},candidate_id:'来源候选ID'}),
    ]},
    {instruction:'导入完成后读取 H3 Prompt，使用该读据 save.args 加 changes 保存。中文可用；duration 为3–15秒，loop 是循环目标，quality 为 preview（低分辨率）或 standard；无需指定帧率。可批量用 prompt.batch.read/save。',calls:[
      call('prompt.read',{project_id,target}),
      call('prompt.save',{project_id,target,expected_sha256:'原读据中的expected_sha256',source_versions:{},changes:{text:'人物挥手，镜头固定。',duration:3,loop:false,quality:'preview',steps:12}}),
    ]},
    {instruction:'核对预检后生成；动态页默认一个候选。提交一次，等待原任务。等待省略 wait_ms 使用固定经验档位，超时用回执 wait.args 续等；中止等待不会取消生成。',calls:[
      call('generation.page.inspect',{project_id,page_key}),
      call('generation.run',{project_id,page_key,count:1}),
      call('task.wait',{targets:[{project_id,task_id:'生成返回的task_id'}]}),
    ]},
    {instruction:'查看终态的图片路径及 task.results/candidate.list 的原视频、抽帧审阅路径。抽帧不能证明全程一致或循环接缝自然。仅在用户授权制作成品时 finished.output，必须传选定视频 candidate_id；内部保留无音频 MP4，不超分、不嵌字，网页下载与 finished.export 使用动画 WebP。',calls:[
      call('candidate.list',{project_id,page_key,task_id:'生成返回的task_id'}),
      call('finished.output',{project_id,page_key,candidate_id:'选定视频候选ID'}),
      call('task.wait',{targets:[{project_id,task_id:'成品返回的任务ID',purpose:'finished'}]}),
    ]},
  ];
  const operations=[...new Set(steps.flatMap(step=>step.calls.map(call=>call.operation)))].map(operation=>({
    operation,summary:actions[operation].summary,parameters:actions[operation].parameters,availability:availability(actions[operation]),
  }));
  return {workflow:'video',usage:'示例中的 ID 和指纹均为占位值，替换为实际回执；保存沿用原 save.args，不重建或清空 source_versions。参数表取当前操作定义，无需逐项查询 help；特殊字段细则再查对应操作。',steps,operations};
}
