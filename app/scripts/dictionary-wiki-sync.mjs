#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { dataLines, parseCsvLine } from "../server/prompt-dictionary.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const endpoint = "https://danbooru.donmai.us/wiki_pages.json";
const userAgent = "StoryCanvas/0.1 (dictionary maintenance)";
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const jsonText = (value) => `${JSON.stringify(value, null, 2)}\n`;

async function readJson(file, fallback) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return fallback; throw error; }
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp`;
  await writeFile(temporary, jsonText(value), "utf8");
  await rename(temporary, file);
}

function ordered(record) {
  return Object.fromEntries(Object.entries(record).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0));
}

export function validateWikiBatch(records, afterId) {
  if (!Array.isArray(records)) throw new Error("Wiki 接口未返回数组，不能视作抓取结束");
  const ids = new Set();
  for (const row of records) {
    if (!Number.isSafeInteger(row.id) || row.id <= afterId || ids.has(row.id)) throw new Error("Wiki ID 游标未前进或出现重复记录");
    if (typeof row.title !== "string" || !row.title || typeof row.body !== "string"
      || !Array.isArray(row.other_names) || row.other_names.some((name) => typeof name !== "string")
      || typeof row.is_deleted !== "boolean" || typeof row.updated_at !== "string" || !Number.isFinite(Date.parse(row.updated_at))) {
      throw new Error(`Wiki 记录字段不完整：${row.id}`);
    }
    ids.add(row.id);
  }
}

/** 按 ID 游标批量同步；正式文件只在完整遍历后发布，中间进度保存在 runtime。 */
export async function syncDictionaryWiki({
  directory = path.join(root, "library/prompt-dictionaries"),
  checkpointFile = path.join(root, "Saved/dictionary-wiki/checkpoint.json"),
  apiUrl = endpoint,
  full = false,
  maxPages = Infinity,
  limit = 1000,
  intervalMs = 1100,
  retryMs = 5000,
  log = console.log,
} = {}) {
  const tagsText = await readFile(path.join(directory, "danbooru.csv"), "utf8");
  const tags = new Set(dataLines(tagsText).map((line) => parseCsvLine(line)[0]?.trim()).filter(Boolean));
  const tagsHash = sha256(tagsText);
  const wikiFile = path.join(directory, "wiki.json");
  const metadataFile = path.join(directory, "wiki-metadata.json");
  const previous = await readJson(metadataFile, null);
  let checkpoint = await readJson(checkpointFile, null);
  if (checkpoint && checkpoint.metadata.sync.status !== "complete" && !full) {
    if (checkpoint.metadata.tags_sha256 !== tagsHash || checkpoint.metadata.api_url !== apiUrl) {
      throw new Error("抓取期间词表或接口发生变化，请用 --full 重新建立快照");
    }
  } else {
    const incremental = !full && previous?.sync.status === "complete" && previous.tags_sha256 === tagsHash && previous.api_url === apiUrl;
    const wiki = incremental ? await readJson(wikiFile, null) : Object.create(null);
    if (wiki === null) throw new Error("Wiki 正文缺失，请用 --full 重新获取");
    if (incremental && sha256(jsonText(wiki)) !== previous.wiki_sha256) throw new Error("Wiki 正文与快照校验值不符，请核对文件或用 --full 重新获取");
    checkpoint = {
      wiki,
      metadata: {
        version: 1,
        api_url: apiUrl,
        page_url_template: "https://danbooru.donmai.us/wiki_pages/{page_id}",
        tags_sha256: tagsHash,
        sync: {
          mode: incremental ? "incremental" : "full",
          status: "running",
          started_at: new Date().toISOString(),
          // 从上次开始时刻重取，覆盖上一轮遍历期间的修改。
          since: incremental ? previous.sync.started_at : null,
          after_id: 0,
          pages: 0,
          records: 0,
        },
        entries: incremental ? previous.entries : Object.create(null),
      },
    };
  }
  const { wiki, metadata } = checkpoint;
  const byId = new Map(Object.entries(metadata.entries).filter(([, entry]) => entry.page_id).map(([name, entry]) => [entry.page_id, name]));
  metadata.sync.status = "running";
  delete metadata.sync.error;
  let requestsThisRun = 0;
  let lastRequestAt = 0;
  try {
    while (requestsThisRun < maxPages) {
      const url = new URL(apiUrl);
      url.search = new URLSearchParams({
        limit: String(limit),
        page: `a${metadata.sync.after_id}`,
        only: "id,title,body,other_names,updated_at,is_deleted",
        ...(metadata.sync.since ? { "search[updated_at]": `>=${metadata.sync.since}` } : {}),
      });
      let rows;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        await delay(Math.max(0, intervalMs - (Date.now() - lastRequestAt)));
        lastRequestAt = Date.now();
        try {
          const response = await fetch(url, {
            headers: { "User-Agent": userAgent, Accept: "application/json" },
            signal: AbortSignal.timeout(30000),
          });
          if (!response.ok) {
            const error = new Error(`Wiki HTTP ${response.status}`);
            error.retryable = response.status === 429 || response.status >= 500;
            const retryAfter = response.headers.get("retry-after");
            const seconds = Number(retryAfter);
            error.retryAfterMs = retryAfter ? (Number.isFinite(seconds) ? seconds * 1000 : Math.max(0, Date.parse(retryAfter) - Date.now())) : 0;
            await response.body?.cancel();
            throw error;
          }
          rows = await response.json();
          break;
        } catch (error) {
          if (error.retryable === false || error instanceof SyntaxError || attempt === 2) throw error;
          const waitMs = Math.max(retryMs * 2 ** attempt, error.retryAfterMs || 0);
          // 长时间限流交给下次续传，避免保持长时间阻塞。
          if (waitMs > 60000) throw error;
          log(`请求暂时失败，${waitMs / 1000} 秒后重试：${error.message}`);
          await delay(waitMs);
        }
      }
      validateWikiBatch(rows, metadata.sync.after_id);
      if (rows.length > limit) throw new Error("Wiki 返回数量超过请求上限");
      const checkedAt = new Date().toISOString();
      for (const row of rows) {
        const oldName = byId.get(row.id);
        if (oldName && oldName !== row.title && metadata.entries[oldName]?.page_id === row.id) {
          delete wiki[oldName];
          metadata.entries[oldName] = { status: "no_wiki", checked_at: checkedAt };
          byId.delete(row.id);
        }
        if (!tags.has(row.title)) continue;
        metadata.entries[row.title] = {
          status: row.is_deleted ? "no_wiki" : "fetched",
          page_id: row.id,
          updated_at: row.updated_at,
          checked_at: checkedAt,
          ...(row.is_deleted ? { is_deleted: true } : {}),
        };
        byId.set(row.id, row.title);
        if (row.is_deleted) delete wiki[row.title];
        else wiki[row.title] = { body: row.body, other_names: row.other_names };
      }
      metadata.sync.pages += 1;
      metadata.sync.records += rows.length;
      if (rows.length) metadata.sync.after_id = Math.max(...rows.map((row) => row.id));
      requestsThisRun += 1;
      if (rows.length === 0) {
        // 只有完整遍历之后才能确认未匹配项；失败和中断不生成“没有说明”的判断。
        for (const tag of tags) {
          if (!Object.hasOwn(metadata.entries, tag)) metadata.entries[tag] = { status: "no_wiki", checked_at: checkedAt };
        }
        metadata.sync.status = "complete";
        metadata.sync.completed_at = checkedAt;
        checkpoint.wiki = ordered(wiki);
        metadata.entries = ordered(metadata.entries);
        metadata.wiki_sha256 = sha256(jsonText(checkpoint.wiki));
        metadata.summary = {
          tags: tags.size,
          wiki_entries: Object.keys(wiki).length,
          with_body: Object.values(wiki).filter((entry) => entry.body.trim()).length,
          with_other_names: Object.values(wiki).filter((entry) => entry.other_names.length).length,
          no_wiki: Object.values(metadata.entries).filter((entry) => entry.status === "no_wiki").length,
        };
        // 先发布正式文件，最后将 checkpoint 标成完成；中途退出仍可安全重新发布。
        await atomicJson(wikiFile, checkpoint.wiki);
        await atomicJson(metadataFile, metadata);
        await atomicJson(checkpointFile, checkpoint);
        log(`完成：${JSON.stringify(metadata.summary)}`);
        return metadata;
      }
      await atomicJson(checkpointFile, checkpoint);
      log(`第 ${metadata.sync.pages} 批：${rows.length} 条，游标 ${metadata.sync.after_id}，匹配词库 ${Object.keys(wiki).length} 条`);
    }
    metadata.sync.status = "partial";
    await atomicJson(checkpointFile, checkpoint);
    log("已保存抓取进度，正式文件未替换；再次运行继续。");
    return metadata;
  } catch (error) {
    metadata.sync.status = "failed";
    metadata.sync.error = { message: error.message, at: new Date().toISOString() };
    await atomicJson(checkpointFile, checkpoint);
    throw error;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help")) {
    console.log("用法：node app/scripts/dictionary-wiki-sync.mjs [--full] [--max-pages N]\n默认继续未完成抓取；已有完整快照时增量更新。--full 重新遍历全部 Wiki。只在完整遍历后发布正式文件。");
  } else {
    try {
      for (let i = 0; i < args.length; i += 1) {
        if (args[i] === "--full") continue;
        if (args[i] === "--max-pages" && /^[1-9]\d*$/.test(args[i + 1] ?? "")) { i += 1; continue; }
        throw new Error(`未知或无效参数：${args[i]}`);
      }
      const index = args.indexOf("--max-pages");
      await syncDictionaryWiki({ full: args.includes("--full"), maxPages: index < 0 ? Infinity : Number(args[index + 1]) });
    } catch (error) {
      console.error(error.message);
      process.exitCode = 1;
    }
  }
}
