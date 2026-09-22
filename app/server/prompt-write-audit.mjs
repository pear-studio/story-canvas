import { compilePagePromptSnapshot, pagePromptDiagnostics } from "./page-render-resolver.mjs";
import { compileEffectiveRenderProfile } from "./render-profile-compiler.mjs";

// 后置诊断不能把已经完成的事实写入变成失败；只包围审计工作，不包围写入。
export async function capturePromptAuditInput(read) {
  try { return { value: await read() }; }
  catch (error) {
    return { diagnostics: [{
      code: error.code ?? "prompt_audit_unavailable",
      message: error.message || String(error),
      ...(error.details ? { details: error.details } : {}),
    }] };
  }
}

export function preparePromptWriteAudit(repositoryRoot) {
  return capturePromptAuditInput(async () => true);
}

export async function auditSavedPagePrompt(repositoryRoot, projectDirectory, prepared, captured) {
  const diagnostics = [...(prepared.diagnostics ?? []), ...(captured?.diagnostics ?? [])];
  if (diagnostics.length) return { status: "unavailable", diagnostics };
  const result = await capturePromptAuditInput(async () => {
    const snapshot = captured.value;
    const profileId = snapshot.project.default_render_profile;
    if (!profileId) throw new Error("project.json 缺少 default_render_profile");
    const bundle = await compileEffectiveRenderProfile({ repositoryRoot, projectRoot: projectDirectory, profileId });
    if (bundle.blocked) {
      const error = new Error("项目生成配置调整存在冲突，Prompt 审计未完成");
      error.code = "render_profile_override_conflict";
      error.details = bundle.override_resolution.conflicts.map((item) => item.target);
      throw error;
    }
    const compiled = compilePagePromptSnapshot(snapshot, bundle.effective_profile);
    return {
      status: "complete", ...compiled.audit,
      diagnostics: pagePromptDiagnostics(compiled),
    };
  });
  return result.value ?? { status: "unavailable", diagnostics: result.diagnostics };
}

export async function auditSavedCharacterPrompt(prepared, captured) {
  const diagnostics = [...(prepared.diagnostics ?? []), ...(captured?.diagnostics ?? [])];
  if (diagnostics.length) return { status: "unavailable", diagnostics };
  const result = await capturePromptAuditInput(() => {
    const { prompt } = captured.value;
    return {
      status: "complete",
      scope: "character_configurations",
      variants: Object.fromEntries(Object.keys(prompt.variants).map((id) => [id, { valid: true, errors: [], warnings: [] }])),
      diagnostics: [],
    };
  });
  return result.value ?? { status: "unavailable", diagnostics: result.diagnostics };
}
