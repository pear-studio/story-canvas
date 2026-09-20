#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const scriptFile = fileURLToPath(import.meta.url);
const defaultRoot = path.resolve(path.dirname(scriptFile), "..", "..");
const stateRelativePath = ".claude/.agent-sync.json";

export class AgentSyncError extends Error {}

function digest(value) {
  return createHash("sha256").update(value).digest("hex");
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n/g, "\n");
}

async function entryInfo(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function parseFrontmatter(source, file) {
  const block = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
  if (!block) throw new AgentSyncError(`${file} 缺少 YAML frontmatter`);

  const fields = new Map();
  for (const line of block[1].split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z0-9_-]+):\s*(.+?)\s*$/);
    if (!match) continue;
    fields.set(match[1], match[2].replace(/^(["'])(.*)\1$/, "$2"));
  }

  if (!fields.get("name")) throw new AgentSyncError(`${file} 缺少 name`);
  if (!fields.get("description")) throw new AgentSyncError(`${file} 缺少 description`);
  return { name: fields.get("name"), description: fields.get("description") };
}

async function discoverSkills(root) {
  const sourceRoot = path.join(root, ".agents", "skills");
  let entries;
  try {
    entries = await readdir(sourceRoot, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new AgentSyncError(`缺少项目技能源：${path.relative(root, sourceRoot)}`);
    }
    throw error;
  }

  const skills = new Map();
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
    const skillRoot = path.join(sourceRoot, entry.name);
    const skillFile = path.join(skillRoot, "SKILL.md");
    let source;
    try {
      source = await readFile(skillFile, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        throw new AgentSyncError(`${path.relative(root, skillRoot)} 缺少 SKILL.md`);
      }
      throw error;
    }
    const metadata = parseFrontmatter(source, path.relative(root, skillFile));
    if (metadata.name !== entry.name) {
      throw new AgentSyncError(
        `${path.relative(root, skillFile)} 的 name 必须与目录名 ${entry.name} 一致`,
      );
    }
    skills.set(entry.name, { root: skillRoot, metadata });
  }
  return skills;
}

async function readState(root) {
  try {
    return JSON.parse(await readFile(path.join(root, stateRelativePath), "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    if (error instanceof SyntaxError) {
      throw new AgentSyncError(`${stateRelativePath} 不是合法 JSON`);
    }
    throw error;
  }
}

function renderClaudeRules(agentRules) {
  return [
    "<!-- 由 docs/agent/sync.mjs 根据 AGENTS.md 生成，请勿直接修改。 -->",
    "",
    agentRules.trimEnd(),
    "",
  ].join("\n");
}

async function resolvedLinkTarget(target) {
  const info = await entryInfo(target);
  if (!info?.isSymbolicLink()) return null;
  const value = await readlink(target);
  return path.resolve(path.dirname(target), value);
}

async function linkMatches(target, source) {
  const linked = await resolvedLinkTarget(target);
  if (!linked) return false;
  try {
    return (await realpath(linked)) === (await realpath(source));
  } catch {
    return path.resolve(linked) === path.resolve(source);
  }
}

function sourceRelativePath(name) {
  return path.posix.join(".agents", "skills", name);
}

async function buildStatus(root = defaultRoot) {
  const resolvedRoot = path.resolve(root);
  const skills = await discoverSkills(resolvedRoot);
  const state = await readState(resolvedRoot);
  const agentFile = path.join(resolvedRoot, "AGENTS.md");
  let agentRules;
  try {
    agentRules = await readFile(agentFile, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw new AgentSyncError("缺少 AGENTS.md");
    throw error;
  }

  const desiredClaude = renderClaudeRules(agentRules);
  const claudeFile = path.join(resolvedRoot, "CLAUDE.md");
  const claudeInfo = await entryInfo(claudeFile);
  const currentClaude = claudeInfo ? await readFile(claudeFile, "utf8") : null;
  const targetRoot = path.join(resolvedRoot, ".claude", "skills");

  return {
    root: resolvedRoot,
    skills,
    state,
    desiredClaude,
    desiredClaudeHash: digest(desiredClaude),
    claudeFile,
    currentClaude,
    targetRoot,
  };
}

export async function inspectAgentConfig({ root = defaultRoot } = {}) {
  const status = await buildStatus(root);
  const errors = [];
  const warnings = [];
  const targets = new Map();

  if (status.currentClaude === null) errors.push("缺少 CLAUDE.md");
  else if (status.currentClaude !== status.desiredClaude) errors.push("CLAUDE.md 与 AGENTS.md 不一致");

  for (const [name, skill] of status.skills) {
    const target = path.join(status.targetRoot, name);
    const info = await entryInfo(target);
    const stateName = info
      ? (await linkMatches(target, skill.root) ? "正常" : "冲突")
      : "缺失";
    targets.set(name, stateName);
    if (stateName !== "正常") errors.push(`Claude 技能 ${name}：${stateName}`);
  }

  const targetRootInfo = await entryInfo(status.targetRoot);
  if (targetRootInfo) {
    for (const entry of await readdir(status.targetRoot, { withFileTypes: true })) {
      if (!status.skills.has(entry.name)) warnings.push(`保留未受管的 Claude 技能：${entry.name}`);
    }
  }

  return { ...status, errors, warnings, targets };
}

export async function applyAgentConfig({ root = defaultRoot, dryRun = false } = {}) {
  const status = await buildStatus(root);
  const actions = [];
  const previousManaged = status.state.managedSkills ?? {};

  if (status.currentClaude !== null && status.currentClaude !== status.desiredClaude) {
    const currentHash = digest(status.currentClaude);
    const lineEndingsOnly = normalizeLineEndings(status.currentClaude) === normalizeLineEndings(status.desiredClaude);
    if (!lineEndingsOnly && (!status.state.rulesHash || status.state.rulesHash !== currentHash)) {
      throw new AgentSyncError("CLAUDE.md 包含未受管修改，拒绝覆盖");
    }
  }

  for (const [name, skill] of status.skills) {
    const target = path.join(status.targetRoot, name);
    const info = await entryInfo(target);
    if (info && !(await linkMatches(target, skill.root))) {
      throw new AgentSyncError(`.claude/skills/${name} 与项目技能源冲突，拒绝覆盖`);
    }
    if (!info) actions.push(`建立 Claude 技能链接：${name}`);
  }

  const stale = [];
  for (const [name, recordedSource] of Object.entries(previousManaged)) {
    if (status.skills.has(name)) continue;
    const target = path.join(status.targetRoot, name);
    const info = await entryInfo(target);
    if (!info) continue;
    const expected = path.resolve(status.root, recordedSource);
    if (!(await linkMatches(target, expected))) {
      throw new AgentSyncError(`旧链接 .claude/skills/${name} 已被修改，拒绝删除`);
    }
    stale.push(target);
    actions.push(`移除过期 Claude 技能链接：${name}`);
  }

  if (status.currentClaude !== status.desiredClaude) actions.unshift("更新 CLAUDE.md");
  if (dryRun) return actions;

  await mkdir(status.targetRoot, { recursive: true });
  if (status.currentClaude !== status.desiredClaude) {
    await writeFile(status.claudeFile, status.desiredClaude, "utf8");
  }
  for (const target of stale) await rm(target, { force: false, recursive: false });
  for (const [name, skill] of status.skills) {
    const target = path.join(status.targetRoot, name);
    if (!(await entryInfo(target))) {
      await symlink(skill.root, target, process.platform === "win32" ? "junction" : "dir");
    }
  }

  const managedSkills = Object.fromEntries(
    [...status.skills.keys()].map((name) => [name, sourceRelativePath(name)]),
  );
  const newState = {
    version: 1,
    rulesHash: status.desiredClaudeHash,
    managedSkills,
  };
  await writeFile(
    path.join(status.root, stateRelativePath),
    `${JSON.stringify(newState, null, 2)}\n`,
    "utf8",
  );
  return actions;
}

function printHelp() {
  console.log(`StoryCanvas Agent 配置同步器

用法：
  node docs/agent/sync.mjs report
  node docs/agent/sync.mjs apply [--dry-run]
  node docs/agent/sync.mjs doctor

范围：
  - AGENTS.md 是项目规则事实来源；CLAUDE.md 是生成结果。
  - .agents/skills 是项目技能源；.claude/skills 是本地链接投影。
  - 不读取或修改任何用户级技能目录。
`);
}

function parseArguments(argv) {
  const command = argv.find((value) => !value.startsWith("--")) ?? "help";
  const dryRun = argv.includes("--dry-run");
  const rootIndex = argv.indexOf("--root");
  const root = rootIndex >= 0 ? argv[rootIndex + 1] : defaultRoot;
  if (rootIndex >= 0 && !root) throw new AgentSyncError("--root 缺少路径");
  return { command, dryRun, root };
}

async function main(argv) {
  const { command, dryRun, root } = parseArguments(argv);
  if (command === "help") {
    printHelp();
    return 0;
  }
  if (command === "apply") {
    const actions = await applyAgentConfig({ root, dryRun });
    console.log(actions.length ? actions.join("\n") : "无需更新");
    if (dryRun) console.log("以上为预演，没有写入文件。");
    return 0;
  }
  if (command === "report" || command === "doctor") {
    const result = await inspectAgentConfig({ root });
    console.log(`项目规则：${result.currentClaude === result.desiredClaude ? "正常" : "需要同步"}`);
    for (const [name, value] of result.targets) console.log(`技能 ${name}：${value}`);
    for (const warning of result.warnings) console.log(`警告：${warning}`);
    for (const error of result.errors) console.error(`错误：${error}`);
    return command === "doctor" && result.errors.length ? 1 : 0;
  }
  throw new AgentSyncError(`未知命令：${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === scriptFile) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (error) {
    console.error(`错误：${error.message}`);
    process.exitCode = 1;
  }
}
