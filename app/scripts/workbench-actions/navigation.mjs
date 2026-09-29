import { navigation, requestWorkbench, projectRoute } from '../workbench-client.mjs';
import { schema, string, pagination } from './contract.mjs';
export const project = { project_id: string('登记中的项目 ID') };
export const id = description => string(description);
export function directory(summary, kind, filters = {}, required = []) {
  return { summary, parameters: schema({ ...project, ...filters, ...pagination }, ['project_id', ...required]),
    details: '返回 {total,offset,items,next_offset}，默认20条、最多50条。只读目录摘要，不是可写草稿；不含正文、Prompt 或图片。next_offset 非空时继续翻页。',
    execute: async args => {const value=(await requestWorkbench('/api/agent/directory', { method: 'POST', body: { ...args, kind } })).value;return kind==='page'?{...value,image_tools:{page:'candidate.list(project_id, page_key)',sequence:'candidate.sheet(project_id, sequence_id)',chapter:'candidate.sheet(project_id, chapter_id)'},image_hint:'用目录中的页面/单元/章节身份查询图片，不用 glob 扫描 Outputs；生成任务的图片用 task.results。'}:value;} };
}
export function navigationAction(summary, route, properties, required = Object.keys(properties), details = '') {
  return { summary, parameters: schema({ ...project, ...properties }, ['project_id', ...required]),
    details: `${details}工具读取最新 revision 后提交一次，返回操作回执（包含目标 ID；删除可能包含归档信息）。章节/单元操作仅返回变动身份及必要诊断，不重复整份骨架；正文用对应 read，顺序用 list 核验。409 后重读并判断，不自动重试。删除须符合用户授权范围；不改索引模拟创建或删除。`,
    execute: async ({ project_id, ...body }) => {
      const result=await navigation(project_id, route, body);
      if(!/^(create|rename|move|delete)-(chapter|sequence)$/.test(route))return result;
      const {value,target_file,...receipt}=result;
      return {saved:true,action:route,...Object.fromEntries(Object.entries(body).filter(([key])=>key.endsWith('_id'))),...receipt};
    } };
}
// 角色子设定改 ID 走已有专用接口；仍使用项目 revision，不误用事实草稿指纹。
export function revisionAction(summary, suffix, properties, details) {
  return { summary, parameters: schema({ ...project, ...properties }), details,
    async execute({ project_id, ...body }) {
      const base = projectRoute(project_id);
      const { value } = await requestWorkbench(`${base}/revision`);
      return (await requestWorkbench(`${base}/workbench/${suffix}`, { method: 'POST', body, revision: value.revision })).value;
    } };
}
