#!/usr/bin/env python3
"""通过 AnimeTimm EVA02 ONNX 模型生成 LoRA 数据集基础 Prompt。"""

from __future__ import annotations

import argparse
import csv
import json
import math
import os
import sys
from pathlib import Path
from typing import Any, Iterable, Sequence


SUPPORTED_CATEGORIES = {0: "general", 4: "character", 9: "rating"}
PROMPT_CATEGORY_ORDER = {4: 0, 0: 1}
AUDIT_CATEGORY_ORDER = {4: 0, 0: 1, 9: 2}
INPUT_SIZE = 448
PAD_SIZE = 512
NORMALIZE_MEAN = (0.48145467042922974, 0.45782750844955444, 0.40821072459220886)
NORMALIZE_STD = (0.2686295509338379, 0.2613025903701782, 0.27577710151672363)
GPU_PROVIDER = "CUDAExecutionProvider"
CPU_PROVIDER = "CPUExecutionProvider"


class CaptionerError(RuntimeError):
    """表示适配器可明确报告的输入、模型或输出错误。"""


def _read_csv(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        raise CaptionerError(f"文件不存在：{path}")
    with path.open("r", encoding="utf-8-sig", newline="") as handle:
        rows = list(csv.DictReader(handle))
    if not rows:
        raise CaptionerError(f"CSV 为空：{path}")
    return rows


def load_labels(path: Path) -> list[dict[str, Any]]:
    rows = _read_csv(path)
    if not {"name", "category"}.issubset(rows[0]):
        raise CaptionerError("selected_tags.csv 缺少 name 或 category 列")
    labels: list[dict[str, Any]] = []
    names: set[str] = set()
    for index, row in enumerate(rows):
        name = str(row.get("name", "")).strip()
        try:
            category = int(row.get("category", ""))
        except ValueError as error:
            raise CaptionerError(f"第 {index + 2} 行的 category 不是整数") from error
        if not name:
            raise CaptionerError(f"第 {index + 2} 行缺少标签名")
        if name in names:
            raise CaptionerError(f"selected_tags.csv 包含重复标签：{name}")
        if category not in SUPPORTED_CATEGORIES:
            raise CaptionerError(f"selected_tags.csv 包含不支持的类别：{category}")
        names.add(name)
        labels.append({"name": name, "category": category})
    return labels


def load_thresholds(path: Path) -> dict[int, float]:
    rows = _read_csv(path)
    if not {"category", "threshold"}.issubset(rows[0]):
        raise CaptionerError("thresholds.csv 缺少 category 或 threshold 列")
    thresholds: dict[int, float] = {}
    for index, row in enumerate(rows):
        try:
            category = int(row.get("category", ""))
            threshold = float(row.get("threshold", ""))
        except ValueError as error:
            raise CaptionerError(f"thresholds.csv 第 {index + 2} 行不是有效数值") from error
        if category not in SUPPORTED_CATEGORIES:
            raise CaptionerError(f"thresholds.csv 包含不支持的类别：{category}")
        if category in thresholds:
            raise CaptionerError(f"thresholds.csv 重复定义类别：{category}")
        if not math.isfinite(threshold) or not 0.0 <= threshold <= 1.0:
            raise CaptionerError(f"类别 {category} 的阈值必须在 0 到 1 之间")
        thresholds[category] = threshold
    missing = sorted(set(SUPPORTED_CATEGORIES) - set(thresholds))
    if missing:
        raise CaptionerError(f"thresholds.csv 缺少类别：{', '.join(map(str, missing))}")
    return thresholds


def build_caption(values: Sequence[float], labels: Sequence[dict[str, Any]], thresholds: dict[int, float]) -> tuple[str, list[dict[str, Any]]]:
    if len(values) != len(labels):
        raise CaptionerError(f"模型输出 {len(values)} 项，但标签表包含 {len(labels)} 项")
    selected: list[dict[str, Any]] = []
    for label, raw_score in zip(labels, values):
        score = float(raw_score)
        if not math.isfinite(score):
            raise CaptionerError(f"标签 {label['name']} 的模型分数不是有限数值")
        category = int(label["category"])
        threshold = thresholds[category]
        if score < threshold:
            continue
        selected.append({
            "name": str(label["name"]),
            "score": round(score, 6),
            "category": category,
            "category_name": SUPPORTED_CATEGORIES[category],
            "threshold": threshold,
        })
    selected.sort(key=lambda tag: (AUDIT_CATEGORY_ORDER[tag["category"]], -tag["score"], tag["name"]))
    prompt_tags = [tag for tag in selected if tag["category"] != 9]
    prompt_tags.sort(key=lambda tag: (PROMPT_CATEGORY_ORDER[tag["category"]], -tag["score"], tag["name"]))
    return ", ".join(tag["name"] for tag in prompt_tags), selected


def load_caption_input(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        raise CaptionerError(f"LORA_CAPTION_INPUT 不存在：{path}")
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as error:
        raise CaptionerError(f"无法读取 LORA_CAPTION_INPUT：{error}") from error
    if not isinstance(payload, dict) or payload.get("version") != 1:
        raise CaptionerError("LORA_CAPTION_INPUT 必须是 version=1 的对象")
    source_items = payload.get("items")
    if not isinstance(source_items, list) or not source_items:
        raise CaptionerError("LORA_CAPTION_INPUT.items 必须是非空数组")
    items: list[dict[str, str]] = []
    item_ids: set[str] = set()
    for index, source in enumerate(source_items):
        if not isinstance(source, dict):
            raise CaptionerError(f"items[{index}] 必须是对象")
        item_id = str(source.get("item_id", "")).strip()
        raw_image_path = str(source.get("image_path", "")).strip()
        if not item_id or not raw_image_path:
            raise CaptionerError(f"items[{index}] 缺少 item_id 或 image_path")
        if item_id in item_ids:
            raise CaptionerError(f"LORA_CAPTION_INPUT 包含重复 item_id：{item_id}")
        image_path = Path(raw_image_path).expanduser().resolve()
        if not image_path.is_file():
            raise CaptionerError(f"图片不存在：{image_path}")
        item_ids.add(item_id)
        items.append({"item_id": item_id, "image_path": str(image_path)})
    return items


def _runtime_modules() -> tuple[Any, Any, Any]:
    try:
        import numpy as np
        import onnxruntime as ort
        from PIL import Image
        if hasattr(ort, "preload_dlls"):
            ort.preload_dlls()
    except ImportError as error:
        raise CaptionerError(f"缺少运行依赖：{error.name}") from error
    return np, ort, Image


def provider_policy_errors(providers: Sequence[str]) -> list[str]:
    requested = [str(provider).strip() for provider in providers if str(provider).strip()]
    problems: list[str] = []
    if not requested or requested[0] != GPU_PROVIDER:
        problems.append(f"必须将 {GPU_PROVIDER} 作为首选 Provider，禁止 CPU-only 执行")
    if CPU_PROVIDER in requested:
        problems.append(f"配置不得显式请求 {CPU_PROVIDER}")
    return problems


def preprocess_image(path: Path) -> Any:
    np, _, Image = _runtime_modules()
    try:
        with Image.open(path) as source:
            source.load()
            image = source.convert("RGB")
    except OSError as error:
        raise CaptionerError(f"无法读取图片 {path}：{error}") from error
    width, height = image.size
    if width <= 0 or height <= 0:
        raise CaptionerError(f"图片尺寸无效：{path}")
    scale = min(PAD_SIZE / width, PAD_SIZE / height)
    resized_width = max(1, round(width * scale))
    resized_height = max(1, round(height * scale))
    image = image.resize((resized_width, resized_height), Image.Resampling.BILINEAR)
    canvas = Image.new("RGB", (PAD_SIZE, PAD_SIZE), (255, 255, 255))
    canvas.paste(image, ((PAD_SIZE - resized_width) // 2, (PAD_SIZE - resized_height) // 2))
    canvas = canvas.resize((INPUT_SIZE, INPUT_SIZE), Image.Resampling.BICUBIC)
    array = np.asarray(canvas, dtype=np.float32) / np.float32(255.0)
    mean = np.asarray(NORMALIZE_MEAN, dtype=np.float32)
    std = np.asarray(NORMALIZE_STD, dtype=np.float32)
    return ((array - mean) / std).transpose(2, 0, 1).astype(np.float32, copy=False)


def create_session(model_path: Path, requested_providers: Sequence[str], intra_op_threads: int = 1, inter_op_threads: int = 1) -> Any:
    if not model_path.is_file():
        raise CaptionerError(f"ONNX 模型不存在：{model_path}")
    policy_problems = provider_policy_errors(requested_providers)
    if policy_problems:
        raise CaptionerError("；".join(policy_problems))
    _, ort, _ = _runtime_modules()
    available = set(ort.get_available_providers())
    missing = [provider for provider in requested_providers if provider not in available]
    if missing:
        raise CaptionerError(f"ONNX Runtime 不支持请求的 Provider：{', '.join(missing)}")
    if intra_op_threads < 1 or inter_op_threads < 1:
        raise CaptionerError("ONNX Runtime 线程数必须大于 0")
    try:
        options = ort.SessionOptions()
        options.intra_op_num_threads = intra_op_threads
        options.inter_op_num_threads = inter_op_threads
        options.execution_mode = ort.ExecutionMode.ORT_SEQUENTIAL
        session = ort.InferenceSession(str(model_path), sess_options=options, providers=list(requested_providers))
        actual_providers = session.get_providers()
        if not actual_providers or actual_providers[0] != GPU_PROVIDER:
            raise CaptionerError(f"ONNX Runtime 未以 {GPU_PROVIDER} 作为首选 Provider")
        return session
    except Exception as error:
        raise CaptionerError(f"无法加载 ONNX 模型：{error}") from error


def infer(session: Any, items: Sequence[dict[str, str]], labels: Sequence[dict[str, Any]], thresholds: dict[int, float], batch_size: int) -> list[dict[str, Any]]:
    np, _, _ = _runtime_modules()
    inputs = session.get_inputs()
    if len(inputs) != 1:
        raise CaptionerError(f"模型应有一个输入，实际为 {len(inputs)} 个")
    if "prediction" not in [output.name for output in session.get_outputs()]:
        raise CaptionerError("模型缺少 prediction 输出")
    input_name = inputs[0].name
    results: list[dict[str, Any]] = []
    for offset in range(0, len(items), batch_size):
        batch_items = items[offset : offset + batch_size]
        batch = np.stack([preprocess_image(Path(item["image_path"])) for item in batch_items])
        try:
            predictions = np.asarray(session.run(["prediction"], {input_name: batch})[0])
        except Exception as error:
            raise CaptionerError(f"ONNX 推理失败：{error}") from error
        if predictions.ndim != 2 or predictions.shape[0] != len(batch_items):
            raise CaptionerError(f"prediction 输出形状无效：{tuple(predictions.shape)}")
        for item, values in zip(batch_items, predictions):
            prompt, raw_tags = build_caption(values, labels, thresholds)
            if not prompt:
                raise CaptionerError(f"图片 {item['item_id']} 未生成可训练标签")
            results.append({"item_id": item["item_id"], "prompt": prompt, "raw_tags": raw_tags})
    return results


def _providers(value: str) -> list[str]:
    providers = [part.strip() for part in value.split(",") if part.strip()]
    if not providers:
        raise argparse.ArgumentTypeError("providers 不能为空")
    return providers


def parse_args(argv: Iterable[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="使用 AnimeTimm EVA02 生成基础 Prompt")
    parser.add_argument("--model", type=Path, required=True, help="model.onnx 路径")
    parser.add_argument("--labels", type=Path, required=True, help="selected_tags.csv 路径")
    parser.add_argument("--thresholds", type=Path, required=True, help="thresholds.csv 路径")
    parser.add_argument("--batch-size", type=int, default=4, help="推理批大小，默认 4")
    parser.add_argument("--providers", type=_providers, default=[GPU_PROVIDER], help="逗号分隔的 ONNX Runtime Provider，必须以 CUDAExecutionProvider 开头")
    parser.add_argument("--intra-op-threads", type=int, default=1, help="ONNX Runtime 算子线程数，默认 1")
    parser.add_argument("--inter-op-threads", type=int, default=1, help="ONNX Runtime 算子间线程数，默认 1")
    parser.add_argument("--check", action="store_true", help="只检查依赖与文件，不加载权重")
    args = parser.parse_args(argv)
    if args.batch_size < 1:
        parser.error("batch-size 必须大于 0")
    if args.intra_op_threads < 1 or args.inter_op_threads < 1:
        parser.error("ONNX Runtime 线程数必须大于 0")
    return args


def check_environment(args: argparse.Namespace) -> dict[str, Any]:
    problems: list[str] = []
    labels: list[dict[str, Any]] = []
    thresholds: dict[int, float] = {}
    try:
        labels = load_labels(args.labels.expanduser().resolve())
    except CaptionerError as error:
        problems.append(str(error))
    try:
        thresholds = load_thresholds(args.thresholds.expanduser().resolve())
    except CaptionerError as error:
        problems.append(str(error))
    if not args.model.expanduser().resolve().is_file():
        problems.append(f"ONNX 模型不存在：{args.model.expanduser().resolve()}")
    runtime: dict[str, Any] = {"onnxruntime": None, "providers": []}
    try:
        _, ort, _ = _runtime_modules()
        runtime = {"onnxruntime": ort.__version__, "providers": ort.get_available_providers()}
        problems.extend(provider_policy_errors(args.providers))
        missing = [provider for provider in args.providers if provider not in runtime["providers"]]
        if missing:
            problems.append(f"ONNX Runtime 不支持请求的 Provider：{', '.join(missing)}")
    except CaptionerError as error:
        problems.append(str(error))
    return {
        "ok": not problems,
        "onnxruntime": runtime["onnxruntime"],
        "providers": runtime["providers"],
        "labels": len(labels),
        "thresholds": len(thresholds),
        "problems": problems,
    }


def main(argv: Iterable[str] | None = None) -> int:
    args = parse_args(argv)
    if args.check:
        json.dump(check_environment(args), sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write("\n")
        return 0
    try:
        input_value = os.environ.get("LORA_CAPTION_INPUT", "").strip()
        if not input_value:
            raise CaptionerError("缺少环境变量 LORA_CAPTION_INPUT")
        items = load_caption_input(Path(input_value).expanduser().resolve())
        labels = load_labels(args.labels.expanduser().resolve())
        thresholds = load_thresholds(args.thresholds.expanduser().resolve())
        session = create_session(args.model.expanduser().resolve(), args.providers, args.intra_op_threads, args.inter_op_threads)
        results = infer(session, items, labels, thresholds, args.batch_size)
        json.dump({"items": results}, sys.stdout, ensure_ascii=False, separators=(",", ":"))
        sys.stdout.write("\n")
        return 0
    except CaptionerError as error:
        print(f"AnimeTimm EVA02 打标失败：{error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
        sys.stderr.reconfigure(encoding="utf-8")
    raise SystemExit(main())
