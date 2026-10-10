import { endpoint, pageKey, encode, downloadArtifact } from './http-action.mjs';
import { schema, string, object, array, boolean, pagination, paginate } from './contract.mjs';
const base='/api/comparison-experiments';
const id={experiment_id:string('实验 ID')};
export const comparisonActions={
  'comparison.list':endpoint('分页查看对比实验','GET',base,pagination,{required:[],transform:(r,a)=>({...paginate(r.value.experiments.map(({id,status})=>({id,status:status.status})),a)})}),
  'comparison.inspect':endpoint('读取实验输入、预检、状态和重试条件','GET',a=>`${base}/${encode(a.experiment_id)}`,id),
  'comparison.options':endpoint('查询可用对比配置','GET',`${base}/input-options`),
  'comparison.blank':endpoint('创建空白输入模板','POST',`${base}/blank-input`,{profile_id:string('配置 ID'),canvas:{...string('画幅'),enum:['3:4','1:1','4:3','2:3','9:16']}},{body:a=>a,details:'只构造可编辑输入模板，不运行模型。通过返回 input 了解完整结构。'}),
  'comparison.import':endpoint('从页面冻结对比输入','POST',`${base}/import`,{project_id:string('源项目 ID'),page_keys:array('页面身份',pageKey,50)},{body:a=>a,details:'返回完整 inputs，可在创建实验前独立修改，不反向修改项目。'}),
  'comparison.lora':endpoint('解析本机 LoRA 为实验输入','POST',`${base}/input-lora`,{source:object('资源来源：{id,kind:"resource",resource_id} 或 {id,kind:"raw",relative_path}；id 为本次实验唯一稳定ID，路径以 loras/ 开头')},{body:a=>a}),
  'comparison.create':endpoint('创建并预检对比实验，不启动生成','POST',base,{id:string('新实验 ID'),inputs:array('comparison.blank/import 返回的完整输入对象',object('输入')),axes:array('对比轴 {type,values:[{value_id,label,value}]}；input 轴可自动生成',object('轴')),registries:object('可选 LoRA 与配置注册表'),lora_sources:array('可选 LoRA 来源',object('来源')),include_lora_baseline:boolean('默认包含基线'),lora_application:object('可选 LoRA 应用方式')},{required:['id','inputs'],body:a=>a,details:'先 blank/import 获得真实输入，修改副本后创建。axes: [{type,values:[{value_id,label,value}]}]。type 为 input/lora_config/character_lora_weight/lora_weight/seed/cfg。input、lora_config 的 value 是输入或注册表ID；权重为-2到2，seed为0到2147483647整数，cfg为大于0且不超过30的数。lora_sources 条目同 comparison.lora.source，会自动冻结 registries；有 LoRA 时同时给 lora_config 与 lora_weight 轴，配置ID对应来源ID，可选 baseline。只创建和预检，不运行模型。'}),
  'comparison.delete':endpoint('删除一个已停止的对比实验','DELETE',a=>`${base}/${encode(a.experiment_id)}`,id,{details:'需用户授权；活动实验先停止并等待终态，不删除运行中的实验。'}),
  'comparison.cancel':endpoint('停止对比实验','POST',a=>`${base}/${encode(a.experiment_id)}/cancel`,id,{details:'允许在极简预设停止已有任务，不启动模型。'}),
  'comparison.image':{summary:'下载某个实验结果图供查看',parameters:schema({...id,cell_id:string('inspect 返回的 cell ID')}),details:'只读取已有结果，落盘到 Saved/Agent/workbench-artifacts。',execute:a=>downloadArtifact(`${base}/${encode(a.experiment_id)}/results/${encode(a.cell_id)}.png`)},
};
const selection = schema({ experiment_id: string('实验ID'), cell_ids: array('可选 cell ID 集合'), axis_values: object('可选 {轴类型:value_id} 过滤') }, ['experiment_id']);
comparisonActions['comparison.create'].details+=' 输入、配置、LoRA 和参考图在创建时冻结，运行后不重读来源项目。对比轴按笛卡尔积展开，启动前 inspect 核对 cell 数量与预检；修改方案另建实验。共用生成队列逐格执行，失败保留已完成成果。';
for(const action of ['review','diff','sheet']) comparisonActions[`comparison.${action}`]=endpoint(`对比结果${action==='review'?'汇总':action==='diff'?'输入差异':'拼图导出'}`,'POST',`${base}/${action}`,{
  selections: array('要查看的实验结果',selection), include_inputs:boolean('是否包含冻结输入'), columns:{type:'integer',minimum:1,maximum:6,description:'拼图列数'},font_size:{type:'integer',minimum:20,maximum:48,description:'拼图字号'},title:string('拼图标题'),labels:array('自定义图片标签')
},{required:['selections'],body:a=>a,details:'selections 每项提供 experiment_id，可指定 cell_ids 或 axis_values:{轴类型:value_id}。省略筛选则选择实验全部结果；只消费已有结果。sheet 的列数、字号、标题、标签可选，返回导出文件路径。'});
comparisonActions['comparison.sheet'].details+=' 一次最多36格，返回PNG及索引；筛选和顺序显式指定，不推断配对。';
comparisonActions['comparison.review'].details+=' 汇总状态、条件和结果路径，冻结输入按需 include_inputs；读图使用 comparison.image，不扫描 Saved。';
