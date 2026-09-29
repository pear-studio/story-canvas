import {createQwenFixtureProject as createProject, installModelResources} from './model-fixture.mjs';
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { handleAgentRequest } from "../server/agent-http.mjs";
import { readProjectCreationTemplate } from "../server/project-creation.mjs";
import { createScene } from "../server/scene-facts.mjs";
import { createPage } from "../server/page-facts.mjs";

test("Agent 公共页事实与 Prompt scope read 返回的草稿可直接 save", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-page-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root, await readProjectCreationTemplate(root, "demo"));
  await createScene(root, "demo", "station", { name: "车站" });
  const page = await createPage(root, "demo", { owner_kind: "scene", scene_id: "station", variant_id: "default" });
  const requestAt = async (decodedPath, body) => {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]); request.method = "POST";
    let result;
    assert.equal(await handleAgentRequest({ request, decodedPath, projectRoot: root,
      readFacts: async (_id, operation) => ({ value: await operation() }),
      mutateTargetFacts: async (_id, operation) => ({ value: await operation() }),
      sendOperation: (status, operation) => { assert.equal(status, 200); result = operation.value; },
    }), true);
    return result;
  };
  const call = (kind, action, body) => requestAt(`/api/agent/facts/page/${kind}/${action}`, body);
  for (const kind of ["content", "text-sources"]) {
    const draft = await call(kind, "read", { project_id: "demo", target_id: page.page_id });
    assert.equal(draft.target_id, page.page_id);
    if (kind === "content") draft.document.title = "场景中的角色验证";
    await call(kind, "save", draft);
    const reread = await call(kind, "read", { project_id: "demo", target_id: page.page_id });
    if (kind === "content") assert.equal(reread.document.title, "场景中的角色验证");
  }
  const target = { kind: 'page', id: page.page_id, model_id: 'qwen' };
  const prompt = await requestAt('/api/agent/prompt/read', { project_id: 'demo', target });
  assert.equal(prompt.document.models, undefined, '读取只包含目标模型分支');
  assert.equal(prompt.save.operation, 'prompt.save');
  await requestAt('/api/agent/prompt/save', { ...prompt.save.args, changes: { text: '站台全景。' } });
  const reread = await requestAt('/api/agent/prompt/read', { project_id: 'demo', target });
  assert.equal(reread.document.text, '站台全景。');
});
