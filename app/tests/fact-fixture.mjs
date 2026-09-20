import { readFactDraft, saveFactDraft } from "../server/fact-drafts.mjs";
import { createProjectOperations } from "../server/project-operations.mjs";
const operations = new Map();
// 用于其他行为测试的已确认保存；确认本身由 inheritance-facts 测试独立验证。
export async function confirmedSave(operation) {
  try { return await operation(); }
  catch (error) {
    if (error.code !== 'inheritance_confirmation_required') throw error;
    return operation(error.details[0].confirmation_sha256);
  }
}
export async function mutateFixture(root, projectId, operation) {
  if (!operations.has(root)) operations.set(root, createProjectOperations({ projectRoot: root }));
  return (await operations.get(root).mutateTargetFacts(projectId, operation)).value;
}
export const fixtureMutation = operation => (root, projectId, ...args) => mutateFixture(root, projectId, () => operation(root, projectId, ...args));

// 领域测试使用与 HTTP 相同的草稿契约，保留并发测试所需的提交钩子。
export function factFixture(domain, kind) {
  return {
    read: (root, projectId, targetId) => readFactDraft(root, { domain, kind, projectId, targetId }),
    save: (root, draft, options = {}) => mutateFixture(root, draft.project_id, () => saveFactDraft(root, {
      domain, kind, projectId: draft.project_id, targetId: draft.target_id, document: draft.document,
      expectedSha256: draft.expected_sha256, expectedContextSha256: draft.expected_context_sha256,
      conflictCode: "fact_target_conflict", contextConflictCode: "fact_upstream_conflict", ...options,
    })),
    saveConfirmed: (root, draft, options = {}) => confirmedSave(confirmationSha256 => factFixture(domain, kind).save(root, draft, { ...options, confirmationSha256 })),
  };
}
