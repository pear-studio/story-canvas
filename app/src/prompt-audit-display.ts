export type PromptIssueLocation = {
  prompt_text?: string;
  path: string;
  token_id?: string | null;
};

export type PromptIssue = {
  code: string;
  message: string;
  source?: string;
  details?: unknown[];
  prompt_text?: string;
  path?: string;
  token_id?: string | null;
  category?: string | null;
  scope?: string | null;
  conflicts_with?: string;
  related?: PromptIssueLocation[];
  danbooru_category?: string;
};

export type PromptAuditResult = {
  valid: boolean;
  errors: PromptIssue[];
  warnings: PromptIssue[];
};

export type PromptAuditReport = ({ status: "complete" } & PromptAuditResult & { diagnostics: PromptIssue[] })
  | { status: "unavailable"; diagnostics: PromptIssue[] };

// 生成禁用原因与流程预览使用同一短说明；完整来源另外展示。
export function promptIssueSummary(issue: PromptIssue): string {

  const words = [...new Set([issue.prompt_text, ...(issue.related ?? []).map((item) => item.prompt_text)].filter(Boolean))];
  return `${words.length ? `${words.map((word) => `“${word}”`).join(" / ")}：` : ""}${issue.message || issue.code}`;
}

export function promptIssueLocations(issue: PromptIssue): string[] {
  const locations = [];
  if (issue.path) locations.push(`来源：${issue.path}`);
  else if (issue.source) locations.push(`来源：${issue.source}`);
  for (const item of issue.related ?? []) {
    locations.push(`关联${item.prompt_text ? `“${item.prompt_text}”` : ""}：${item.path}`);
  }
  if (issue.conflicts_with && !issue.related?.some((item) => item.path === issue.conflicts_with)) {
    locations.push(`冲突来源：${issue.conflicts_with}`);
  }
  if (!issue.path && !issue.source) {
    locations.push(...(issue.details ?? []).filter((item): item is string => typeof item === "string"));
  }
  return locations;
}
