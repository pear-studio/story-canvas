import {cp} from 'node:fs/promises';
import path from 'node:path';
import {createProject} from '../server/project-creation.mjs';
export async function installModelResources(root) {
  for(const folder of ['render-profiles','render-recipes','workflows','prompt-policies','visual-page-templates'])await cp(new URL(`../../library/${folder}`,import.meta.url),path.join(root,'library',folder),{recursive:true});
}
// 既有 HTTP/导航测试明确选择 Qwen，避免随着新项目默认模型变化而改变测试主题。
export async function createQwenFixtureProject(root,session,options) {
  await installModelResources(root);
  const document=structuredClone(session.document);document.metadata.default_render_profile='qwen-image-2-1';
  return createProject(root,{...session,document},options);
}
