import { requestWorkbench } from '../workbench-client.mjs';
import { schema, string, object, pagination, paginate } from './contract.mjs';
const projectId = { project_id: string('登记中的真实项目 ID，先用 project.list 查询') };
const route = id => `/api/project-library/${encodeURIComponent(id)}`;
const post = async (path, body) => (await requestWorkbench(path, { method: 'POST', body })).value;
// 摘要、参数、细则和执行函数属于同一声明。
export const projectActions = {
  'project.list': {
    summary: '分页查看已登记项目摘要', parameters: schema(pagination, []),
    details: '返回 id/title/type/temporary/available，不载入项目正文；next_offset 非空时继续翻页。实际目录与 Git 状态用 project.info。',
    async execute(args) {
      const { value } = await requestWorkbench('/api/project-library');
      return paginate(value.projects.map(({ id, title, type, temporary, available }) => ({ id, title, type, temporary, available })), args);
    },
  },
  'project.info': {
    summary: '查看项目登记详情和只读 Git 状态', parameters: schema(projectId),
    details: '不初始化 Git，不提交、同步或扫描未登记目录。',
    async execute({ project_id }) {
      const { value } = await requestWorkbench('/api/project-library');
      const entry = value.projects.find(item => item.id === project_id);
      if (!entry) throw Object.assign(new Error('项目未登记'), { code: 'project_not_registered', status: 404 });
      return { ...entry, git: (await requestWorkbench(`${route(project_id)}/git`)).value };
    },
  },
  'project.copy': {
    summary: '将现有项目复制为临时项目', parameters: schema(projectId),
    details: '复制事实与输入，不带旧 Git、生成结果、训练历史和缓存；要求项目没有活动任务。返回新登记，后续使用返回的 id。工具处理路径，无需 revision。',
    example: { project_id: 'demo' }, execute: ({ project_id }) => post(`${route(project_id)}/copy`, {}),
  },
  'project.promote': {
    summary: '将临时项目保留为正式项目', parameters: schema({ ...projectId, path: string('不存在的外部绝对目录') }),
    details: '要求项目空闲且为 workspace 直接子目录。完整复制核验、保留成果、初始化 Git、更新登记后移除临时目录；不创建提交。',
    execute: ({ project_id, path }) => post(`${route(project_id)}/promote`, { path }),
  },
  'project.forget': {
    summary: '从列表移除登记，保留磁盘文件', parameters: schema(projectId),
    details: '不删除项目文件或 Git；需要恢复时用 project.open。',
    execute: ({ project_id }) => post(`${route(project_id)}/forget`, {}),
  },
  'project.delete': {
    summary: '删除临时项目及全部文件', parameters: schema(projectId),
    details: '仅支持 workspace 直接子目录中的临时项目，要求空闲；必须已有用户删除授权。正式项目不能使用此操作删除文件。',
    execute: ({ project_id }) => post(`${route(project_id)}/delete`, {}),
  },
  'project.open': {
    summary: '登记已有项目目录', parameters: schema({ path: string('含 project.json 的已有绝对目录') }),
    details: '仅登记，不复制；训练项目还需 settings.json。', execute: ({ path }) => post('/api/project-library/open', { path }),
  },
  'project.relocate': {
    summary: '更新已搬迁项目的登记路径', parameters: schema({ ...projectId, path: string('已移动后的绝对目录') }),
    details: '只更新登记，不搬运文件。', execute: ({ project_id, path }) => post(`${route(project_id)}/relocate`, { path }),
  },
  'project.template': {
    summary: '取得干净新项目的创建草稿', parameters: schema({ project_id: string('新项目 ID') }),
    details: '返回完整模板；只修改 document，再用 project.create 提交完整模板。', execute: args => post('/api/agent/project-create/template', args),
  },
  'project.create': {
    summary: '用完整创建草稿新建项目', parameters: schema({ draft: object('project.template 返回的完整模板，只改 document') }),
    details: '创建干净剧情项目；复制已有内容请用 project.copy。不自行构造缺失模板。', execute: ({ draft }) => post('/api/agent/project-create/create', draft),
  },
};
