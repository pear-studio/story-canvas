// 最小必要审计：分类、词库命中、逐词权重、人数与 tag 预算检查已随结构化词条移除。
function issue(code, message) {
  return { code, message };
}

export function pagePromptAudit({ missing = [], errors = [], positive = "" } = {}) {
  const issues = [
    ...missing.map((message) => issue("page_prompt_missing", message)),
    ...errors.map((message) => issue("page_prompt_invalid", message)),
    ...(!positive.trim() ? [issue("positive_prompt_empty", "Positive Prompt 为空")] : []),
  ];
  return {
    valid: issues.length === 0,
    errors: issues,
    warnings: [],
  };
}
