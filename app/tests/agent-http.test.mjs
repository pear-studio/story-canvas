import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { handleAgentRequest } from "../server/agent-http.mjs";
import { createProject, readProjectCreationTemplate } from "../server/project-creation.mjs";
import { createScene } from "../server/scene-facts.mjs";
import { createPage } from "../server/page-facts.mjs";

test("Agent 公共页 content/prompt/text-sources read 返回的草稿可直接 save", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-page-http-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await createProject(root, await readProjectCreationTemplate(root, "demo"));
  await createScene(root, "demo", "station", { name: "车站" });
  const page = await createPage(root, "demo", { owner_kind: "scene", scene_id: "station", variant_id: "default" });
  const call = async (kind, action, body) => {
    const request = Readable.from([Buffer.from(JSON.stringify(body))]); request.method = "POST";
    let result;
    assert.equal(await handleAgentRequest({ request, decodedPath: `/api/agent/facts/page/${kind}/${action}`, projectRoot: root,
      readFacts: async (_id, operation) => ({ value: await operation() }),
      mutateTargetFacts: async (_id, operation) => ({ value: await operation() }),
      sendOperation: (status, operation) => { assert.equal(status, 200); result = operation.value; },
    }), true);
    return result;
  };
  for (const kind of ["content", "prompt", "text-sources"]) {
    const draft = await call(kind, "read", { project_id: "demo", target_id: page.page_id });
    assert.equal(draft.target_id, page.page_id);
    if (kind === "content") draft.document.title = "场景中的角色验证";
    if (kind === "prompt") draft.document.text = "站台全景。";
    await call(kind, "save", draft);
    const reread = await call(kind, "read", { project_id: "demo", target_id: page.page_id });
    if (kind === "content") assert.equal(reread.document.title, "场景中的角色验证");
    if (kind === "prompt") assert.equal(reread.document.text, "站台全景。");
  }
});
