#!/usr/bin/env node

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { buildPromptDictionary, dataLines, parseCsvLine, parsePromptDictionaryWiki } from "../server/prompt-dictionary.mjs";

const scriptFile = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(scriptFile), "..", "..");
const dictionaryDirectory = path.join(repoRoot, "library", "prompt-dictionaries");

function argumentValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : null;
}

function usage() {
  console.error("用法:");
  console.error("  node scripts/dictionary-lookup.mjs --top 500 [--out file.json]");
  console.error("  node scripts/dictionary-lookup.mjs --words file.txt [--out file.json]");
  console.error("输出词条参考 JSON：原标签、频次、类型、CSV 译名、当前译名、别名、Wiki 原文、其他名称及有效说明。");
  process.exit(2);
}

async function main() {
  const top = argumentValue("--top");
  const wordsFile = argumentValue("--words");
  const outFile = argumentValue("--out");
  if ((!top && !wordsFile) || (top && wordsFile)) usage();

  const readOptional = async (name) => readFile(path.join(dictionaryDirectory, name), "utf8").catch((error) => {
    if (error.code === "ENOENT") return "";
    throw error;
  });
  const [tagsSource, translationsSource, overlaySource, wikiSource] = await Promise.all([
    readFile(path.join(dictionaryDirectory, "danbooru.csv"), "utf8"),
    readFile(path.join(dictionaryDirectory, "zh.csv"), "utf8"),
    readOptional("overlay.json"),
    readOptional("wiki.json"),
  ]);
  const entries = new Map(buildPromptDictionary(tagsSource, translationsSource, overlaySource, wikiSource)
    .map((entry) => [entry.source_text, entry]));
  const wiki = parsePromptDictionaryWiki(wikiSource);

  const translations = new Map();
  for (const line of dataLines(translationsSource)) {
    const [source, translation] = parseCsvLine(line);
    if (source?.trim() && translation?.trim()) translations.set(source.trim().toLowerCase(), translation.trim());
  }

  const rows = [];
  for (const line of dataLines(tagsSource)) {
    const [nameValue, type = "0", countValue = "0", aliasValue = ""] = parseCsvLine(line);
    const name = nameValue?.trim();
    if (!name) continue;
    const entry = entries.get(name);
    rows.push({
      source_text: name,
      provider_type: type,
      post_count: Number.parseInt(countValue, 10) || 0,
      zh: translations.get(name.toLowerCase()) ?? null,
      aliases: aliasValue.split(",").map((alias) => alias.trim()).filter(Boolean),
      display_text: entry.display_text,
      prompt_text: entry.prompt_text,
      body: Object.hasOwn(wiki, name) ? wiki[name].body : null,
      other_names: entry.other_names ?? [],
      description: entry.description ?? null,
      description_language: entry.description_language ?? null,
    });
  }

  let words;
  if (top) {
    const count = Number.parseInt(top, 10);
    if (!Number.isInteger(count) || count <= 0) usage();
    // 初版标注范围：general 类型词按 post_count 降序；artist/character/copyright/meta 词不占额度。
    words = rows.filter((row) => row.provider_type === "0").sort((left, right) => right.post_count - left.post_count).slice(0, count);
  } else {
    const requested = dataLines(await readFile(path.resolve(wordsFile), "utf8")).map((line) => parseCsvLine(line)[0]?.trim()).filter(Boolean);
    const byName = new Map(rows.map((row) => [row.source_text, row]));
    words = requested.map((name) => byName.get(name) ?? {
      source_text: name, provider_type: null, post_count: 0, zh: null, aliases: [],
      display_text: null, prompt_text: null, body: null, other_names: [], description: null, description_language: null, missing: true,
    });
  }

  const payload = JSON.stringify({ words }, null, 2);
  if (outFile) {
    await writeFile(path.resolve(outFile), `${payload}\n`, "utf8");
    console.error(`已写入 ${outFile}（${words.length} 条）`);
  } else process.stdout.write(`${payload}\n`);
}

await main();
