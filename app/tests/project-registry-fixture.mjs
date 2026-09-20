import { readdirSync } from "node:fs";
import path from "node:path";
import { registerProject, readProjectRegistry } from "../server/project-registry.mjs";
// 旧测试的材料构造仍使用 workspace；构造完成后显式登记，生产代码不扫描目录。
export function registerFixtureProjects(root) {
  let entries;
  try { entries = readdirSync(path.join(root, "workspace"), { withFileTypes: true }); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  for (const entry of entries) if (entry.isDirectory() && !entry.name.startsWith(".") && !readProjectRegistry(root).some(item => path.resolve(item.path) === path.resolve(root,"workspace",entry.name))) registerProject(root, { id: entry.name, type: "story", path: path.resolve(root, "workspace", entry.name), temporary: true });
}
