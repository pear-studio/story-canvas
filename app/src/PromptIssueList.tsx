import { promptIssueLocations, promptIssueSummary, type PromptIssue } from "./prompt-audit-display";

export function PromptIssueList({ issues, title, tone = "error" }: { issues: PromptIssue[]; title?: string; tone?: "error" | "warning" }) {
  return <section className={`prompt-issue-list prompt-issue-list--${tone}`}>
    {title && <b>{title}</b>}
    {issues.map((issue, index) => <div className="prompt-issue" key={`${issue.code}:${index}`}><p>{promptIssueSummary(issue)}</p>{promptIssueLocations(issue).map((location, locationIndex) => <code key={locationIndex}>{location}</code>)}</div>)}
  </section>;
}
