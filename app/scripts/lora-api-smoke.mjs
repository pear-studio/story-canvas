#!/usr/bin/env node
// 使用隔离目录验证全局训练 API，不创建故事项目或启动 GPU 训练。
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const child = spawn(process.execPath, ["--test", fileURLToPath(new URL("../tests/lora-training-http.test.mjs", import.meta.url))], { stdio: "inherit", windowsHide: true });
child.on("error", error => { console.error(error); process.exitCode = 1; });
child.on("exit", code => { process.exitCode = code ?? 1; });
