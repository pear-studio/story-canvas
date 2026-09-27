import { readFactDraft, saveFactDraft, fingerprintErrors } from './fact-drafts.mjs';
import { decodePageKey } from './page-key.mjs';
import { hashCanonicalJson } from './workflow-definition.mjs';
import { ApiError } from './http-support.mjs';

function target(options) {
  const section = options.section ?? 'prompt';
  if (!['prompt','content','render'].includes(section)) throw new ApiError(400,'invalid_page_section');
  return {domain:'page',kind:section,projectId:options.projectId,targetId:decodePageKey(options.pageKey).page_id};
}
const version = (identity, draft) => hashCanonicalJson({identity,target:draft.expected_sha256,upstream:draft.expected_context_sha256});
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);

// 对象递归合并；数组和标量整项替换；null 明确删除键。未涉及字段保留。
export function applyDocumentChanges(document, changes) {
  const entries = new Map(Object.entries(record(document) ? document : {}));
  for (const [key,value] of Object.entries(changes)) {
    if (value === null) entries.delete(key);
    else entries.set(key,record(value) ? applyDocumentChanges(entries.get(key),value) : structuredClone(value));
  }
  return Object.fromEntries(entries);
}

// 读取相关页面文件的完整正文，不编译或展开上游 Prompt。
export async function readPageEditContext(options) {
  const identity = target(options);
  const draft = await readFactDraft(options.projectRoot,identity);
  return {document:draft.document,save:{operation:'page.editor.save',args:{
    project_id:options.projectId,page_key:options.pageKey,section:identity.kind,expected_sha256:version(identity,draft),
  },patch_parameter:'changes'}};
}

// 调用者持有 mutateTargetFacts 边界；先比对读取版本，再合并并复用领域提交校验。
export async function savePageEditChanges(options) {
  const errors=fingerprintErrors({expected_sha256:options.expectedSha256},['expected_sha256']);
  if(errors.length)throw new ApiError(400,'invalid_page_edit_fingerprint',errors);
  if (!record(options.changes) || !Object.keys(options.changes).length) throw new ApiError(400,'invalid_page_changes',['changes 必须是非空对象']);
  const identity = target(options);
  const draft = await readFactDraft(options.projectRoot,identity);
  if (options.expectedSha256 !== version(identity,draft)) throw new ApiError(409,'page_edit_conflict',['页面文件或上游已变化，请重新读取后判断']);
  const receipt = await saveFactDraft(options.projectRoot,{
    ...identity,document:applyDocumentChanges(draft.document,options.changes),
    expectedSha256:draft.expected_sha256,expectedContextSha256:draft.expected_context_sha256,
    conflictCode:'page_edit_conflict',contextConflictCode:'page_edit_conflict',
  });
  return {saved:true,...await readPageEditContext(options),
    ...(receipt.audit ? {audit:Object.fromEntries(Object.entries(receipt.audit).filter(([key,value]) => ['status','valid','errors','warnings','diagnostics'].includes(key) && (!Array.isArray(value)||value.length)))} : {}),
    ...(receipt.warnings?.length ? {warnings:receipt.warnings} : {}),
    ...(receipt.downstream_diagnostics?.length ? {downstream_diagnostics:receipt.downstream_diagnostics} : {})};
}
