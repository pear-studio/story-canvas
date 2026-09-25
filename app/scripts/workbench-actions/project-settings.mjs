import { requestWorkbench, projectRoute } from '../workbench-client.mjs';
import { schema, string, object, pagination, paginate } from './contract.mjs';
import { project } from './navigation.mjs';

const read = (id, suffix) => requestWorkbench(`${projectRoute(id)}/${suffix}`);
const conflict = () => { throw Object.assign(new Error('读取期间项目已变化，请重新读取'), { status: 409, code: 'revision_conflict' }); };
export async function putProject(id, suffix, body, revision) {
  return (await requestWorkbench(`${projectRoute(id)}/${suffix}`, { method: 'PUT', body, revision })).value;
}
const profiles = (id, profileId) => read(id, 'render-profile' + (profileId ? `?profile_id=${encodeURIComponent(profileId)}` : ''));
function selected(value, id) {
  const profile = value.render_profiles.find(p => p.id === (id ?? value.current_profile_id));
  if (!profile) throw Object.assign(new Error('生成配置不存在'), { code: 'profile_not_found' });
  return profile;
}
export const projectSettingsActions = {
  'project.settings.read': {
    summary: '读取标题、画幅和默认生成配置及 revision', parameters: schema(project),
    details: '返回 {value,revision}；修改 value 后通过 project.settings.save 保存。无需读取工作台全量正文。',
    execute: ({ project_id }) => read(project_id, 'project'),
  },
  'project.settings.save': {
    summary: '保存项目基本设置', parameters: schema({ ...project, value: object('read 返回的完整 value：title、canvas、default_render_profile'), revision: string('read 返回的 revision') }),
    details: '必须携带读取时的 revision；画幅支持3:4、1:1、4:3、2:3、9:16。不会改写各页面模型。409 重新读取，不自动覆盖。',
    execute: ({ project_id, value, revision }) => putProject(project_id, 'project', value, revision),
  },
  'generation.profiles': {
    summary: '列出项目可选生成配置摘要', parameters: schema({ ...project, ...pagination }, ['project_id']),
    details: '返回当前默认配置及分页摘要；详细有效配置、LoRA、全局 Prompt 和冲突通过 generation.inspect 查询。',
    async execute({ project_id, ...args }) { const { value } = await profiles(project_id); return { current_profile_id: value.current_profile_id, ...paginate(value.render_profiles.map(({ id, name, architecture_family, available }) => ({ id, name, architecture_family, available })), args) }; },
  },
  'generation.inspect': {
    summary: '查看一个配置的有效参数、LoRA、Prompt 和诊断', parameters: schema({ ...project, profile_id: string('省略为项目默认配置') }, ['project_id']),
    details: '返回单个完整配置和 revision。页面自己的模型设置另用 facts.read/save page/render；不假定默认配置覆盖所有页面。',
    async execute({ project_id, profile_id }) { const { value, revision } = await profiles(project_id, profile_id); return { value: selected(value, profile_id), revision }; },
  },
  'generation.select': {
    summary: '选择项目默认生成配置', parameters: schema({ ...project, profile_id: string('generation.profiles 返回的 ID'), revision: string('generation.inspect 返回的 revision') }),
    details: '只更改默认配置，不迁移已有页面；页面配置用 page/render 草稿。',
    execute: ({ project_id, profile_id, revision }) => putProject(project_id, 'render-profile', { id: profile_id }, revision),
  },
  'generation.override.read': {
    summary: '读取完整项目生成调整草稿', parameters: schema(project),
    details: '返回 {value:{override},revision}。用于高级参数调整；LoRA 优先用 generation.lora.set/remove。',
    execute: ({ project_id }) => read(project_id, 'render-profile-override'),
  },
  'generation.override.save': {
    summary: '保存项目生成调整，保留三方冲突检查', parameters: schema({ ...project, document: object('read 返回的 value.override 完整文档'), revision: string('读取时的 revision') }),
    details: '文档 {version:1,profiles:{配置ID:{changes:[{target,original:{exists,value?},project:{exists,value?}}]}}。original 必须保留真实基础值，不能猜。target 包括 prompt.text、style_loras.ID、style_loras.ID.weight 和 inspection 中的语义参数。未知 target 查 generation.inspect；仍缺说明时请求补充工具。不会启动生成。',
    execute: ({ project_id, document, revision }) => putProject(project_id, 'render-profile-override', document, revision),
  },
};

// 在已读 revision 上做窄修改；不使用新 revision 掩盖陈旧读取。
export async function editProfileLora({ project_id, profile_id, lora_id, resource_id, weight, trigger, revision }, remove = false) {
  const snapshot = await profiles(project_id, profile_id);
  if (snapshot.revision !== revision) conflict();
  const profile = selected(snapshot.value, profile_id);
  if (!profile.inspection || profile.configuration_error || profile.inspection.project_override?.status === 'conflict') throw Object.assign(new Error('配置不可用或存在冲突，先 generation.inspect'), { code: 'profile_conflict', status: 409 });
  const documentRead = await read(project_id, 'render-profile-override');
  if (documentRead.revision !== revision) conflict();
  const document = documentRead.value.override;
  const active = profile.inspection.style_loras ?? {};
  if (!remove && lora_id && !active[lora_id]) throw Object.assign(new Error('要替换的 LoRA ID 不存在，先 generation.inspect'), { code: 'lora_not_active' });
  let definition;
  if (!remove) {
    const { value: list } = await requestWorkbench('/api/lora-resources');
    const registered = list.resources.find(item => item.resource.id === resource_id);
    const raw = list.raw.find(item => item.id === resource_id);
    if (!registered && !raw) throw Object.assign(new Error('LoRA 资源不存在，先 resource.lora.list'), { code: 'lora_not_found' });
    const resource = registered?.resource;
    if ((registered ?? raw).status !== 'available') throw Object.assign(new Error('LoRA 文件不可用或身份不符'), { code: 'lora_unavailable' });
    if (resource && resource.architecture.family !== profile.architecture_family) throw Object.assign(new Error('LoRA 与生成配置的架构不匹配'), { code: 'lora_incompatible' });
    const file = resource?.file ?? raw;
    const recommended = resource?.recommended_generation?.weight?.default;
    const finalWeight = weight ?? (typeof recommended === 'number' && recommended >= -2 && recommended <= 2 ? recommended : 1);
    const finalTrigger = trigger ?? resource?.activation?.trigger_words?.join(', ') ?? '';
    definition = { filename: file.relative_path.replace(/^loras\//, ''), sha256: file.sha256, weight: finalWeight, ...(finalTrigger ? { trigger: finalTrigger } : {}) };
    lora_id ??= Object.values(active).find(item => item.sha256 === definition.sha256)?.id ?? resource_id;
  }
  const group = document.profiles[profile.id] ?? { changes: [] };
  const target = `style_loras.${lora_id}`;
  const whole = group.changes.find(c => c.target === target);
  const narrow = group.changes.find(c => c.target === `${target}.weight`);
  const previous = active[lora_id];
  if (remove && !previous && !whole) throw Object.assign(new Error('当前配置没有该 LoRA'), { code: 'lora_not_active' });
  const original = whole?.original ?? (previous ? { exists: true, value: { filename: previous.filename, sha256: previous.sha256, weight: narrow?.original?.value ?? previous.weight ?? 1, ...(previous.trigger ? { trigger: previous.trigger } : {}) } } : { exists: false });
  const changes = group.changes.filter(c => c.target !== target && c.target !== `${target}.weight`);
  if (!remove || original.exists) changes.push({ target, original, project: remove ? { exists: false } : { exists: true, value: definition } });
  document.profiles[profile.id] = { ...group, changes };
  return putProject(project_id, 'render-profile-override', document, revision);
}
projectSettingsActions['generation.lora.set'] = {
  summary: '添加或替换项目风格 LoRA，可设置权重和触发词',
  parameters: schema({ ...project, resource_id: string('resource.lora.list 的真实 ID，支持未登记权重'), profile_id: string('省略为默认配置'), lora_id: string('替换时指定当前 LoRA ID；省略按同 SHA 匹配或新增'), weight: { type: 'number', minimum: -2, maximum: 2, description: '省略使用资源推荐值，未登记为1' }, trigger: { type: 'string', allowEmpty: true, description: '省略用资源默认触发词；空串清除' }, revision: string('generation.inspect 返回的 revision') }, ['project_id', 'resource_id', 'revision']),
  details: '须已有用户 LoRA 修改授权。自动读取资源路径与 SHA，不搜索文件或训练目录；未登记资源不推断兼容性，默认权重1、无触发词。lora_id 指定当前项可单次替换；保留其他 LoRA 和参数，不生成图片。保存后 generation.inspect 核对。',
  execute: args => editProfileLora(args),
};
projectSettingsActions['generation.lora.remove'] = {
  summary: '移除一个项目风格 LoRA', parameters: schema({ ...project, lora_id: string('generation.inspect 中的 LoRA ID'), profile_id: string('省略为默认配置'), revision: string('读取时的 revision') }, ['project_id', 'lora_id', 'revision']),
  details: '须已有用户授权。只移除指定配置项，不删除模型文件；保留其他调整。', execute: args => editProfileLora(args, true),
};
