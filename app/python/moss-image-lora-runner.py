"""MOSS SFT BF16 的冻结训练入口；只导出 LoRA，不提供优化器精确续训。"""
import argparse
import gc
import hashlib
import importlib.util
import json
import math
import os
from pathlib import Path
import random
import sys
import time

RUNNER_NAME = "moss-image-lora-runner"
RUNNER_VERSION = 1


class RunnerError(RuntimeError):
    pass


def sha256(path):
    digest = hashlib.sha256()
    with Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(8 * 1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + f".{os.getpid()}.tmp")
    temporary.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(temporary, path)


def child_path(root, relative):
    root = Path(root).resolve()
    result = (root / relative).resolve()
    if not result.is_relative_to(root):
        raise RunnerError(f"路径超出冻结目录：{relative}")
    return result


class Events:
    def __init__(self, path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, event, **data):
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"v": 1, "event": event, "time": time.time(), **data}, ensure_ascii=False) + "\n")


def validate_manifest(manifest):
    if manifest.get("version") != 6 or manifest.get("family") != "moss-image":
        raise RunnerError("MOSS runner 只接受 version 6、family=moss-image 的冻结 manifest")
    if manifest.get("resume"):
        raise RunnerError("MOSS 暂不支持精确续训")
    sc = manifest["semantic_config"]
    if sc["micro_batch_size"] != 1 or sc["optimizer"]["type"] != "AdamW" or sc["scheduler"]["type"] != "ConstantLR":
        raise RunnerError("MOSS 只支持 micro_batch_size=1、AdamW、ConstantLR")
    if sc["precision"] != {"base": "bf16", "lora": "fp32", "optimizer_state": "fp32"}:
        raise RunnerError("MOSS 只支持 BF16 底座、FP32 LoRA 与优化器状态")
    if not sc.get("lora_target_modules") or not all(isinstance(name, str) and name for name in sc["lora_target_modules"]):
        raise RunnerError("必须冻结明确的 LoRA target modules")
    if sc["network_dim"] != sc["network_alpha"]:
        raise RunnerError("MOSS 当前配方要求 Alpha 等于 Rank")
    for key in ("max_pixels", "network_dim", "gradient_accumulation_steps"):
        if not isinstance(sc[key], int) or sc[key] < 1:
            raise RunnerError(f"无效训练参数：{key}")
    if not math.isfinite(sc["learning_rate"]) or sc["learning_rate"] <= 0:
        raise RunnerError("learning_rate 必须为有限正数")
    for key in ("max_train_steps", "save_every_n_steps"):
        if not isinstance(manifest["run"][key], int) or manifest["run"][key] < 1:
            raise RunnerError(f"无效运行参数：{key}")
    ids = [item["item_id"] for item in manifest["items"]]
    if not ids or len(ids) != len(set(ids)):
        raise RunnerError("冻结素材为空或存在重复 item_id")
    weights = manifest["sampling"]["weights"]
    if not weights or len({w["item_id"] for w in weights}) != len(weights):
        raise RunnerError("采样权重为空或重复")
    for weight in weights:
        if weight["item_id"] not in ids or not isinstance(weight["weight"], int) or weight["weight"] < 1:
            raise RunnerError("采样权重必须引用冻结素材且为正整数")


def verify_inputs(manifest, item):
    root = manifest["paths"]["inputs_dir"]
    image = child_path(root, item["image_file"])
    caption = child_path(root, item["caption_file"])
    if sha256(image) != item["image_sha256"] or sha256(caption) != item["caption_sha256"]:
        raise RunnerError(f"冻结图片或 Caption hash 不符：{item['item_id']}")
    return image, caption.read_bytes().decode("utf-8")


def verify_models(manifest):
    groups = {}
    for record in manifest["models"]:
        path = child_path(manifest["paths"]["models_root"], record["relative_path"])
        if path.stat().st_size != record["size_bytes"] or sha256(path) != record["sha256"]:
            raise RunnerError(f"模型身份不符：{record['relative_path']}")
        kind = record["kind"]
        if kind == "tokenizer" or path.suffix == ".safetensors":
            groups.setdefault(kind, []).append(str(path))
    if any(not groups.get(kind) for kind in ("dit", "vae", "text_encoder", "tokenizer")):
        raise RunnerError("冻结模型缺少 DiT、VAE、文本编码器或 tokenizer")
    return groups


def split_fused_qkv(state):
    """Comfy MOSS SFT 将 q/k/v 顺序沿输出维融合；DiffSynth 使用独立 Linear。"""
    result = dict(state)
    for key, tensor in state.items():
        if key.endswith(".proj.qkv.weight"):
            if len(tensor.shape) != 2 or tensor.shape[0] != tensor.shape[1] * 3:
                raise RunnerError(f"不支持的 MOSS QKV shape：{key}")
            del result[key]
            for name, part in zip("qkv", tensor.chunk(3, dim=0)):
                target = key.replace(".proj.qkv.weight", f".proj.{name}.weight")
                if target in result:
                    raise RunnerError(f"混合融合/非融合 QKV 权重：{target}")
                result[target] = part
    return result


def load_sft_dit(paths, target_names, device):
    """显式加载固定模型类，避免上游仍按原 fused 文件头自动识别。"""
    import torch
    from safetensors.torch import load_file
    from diffsynth.models.moss_image_dit import MOSSImageDiT
    state = {}
    for path in paths:
        part = load_file(path, device="cpu")
        if set(state).intersection(part):
            raise RunnerError("DiT 分片存在重复参数")
        state.update(part)
    state = split_fused_qkv(state)
    with torch.device("meta"):
        model = MOSSImageDiT()
    expected = model.state_dict()
    if set(state) != set(expected) or any(state[key].shape != expected[key].shape for key in expected):
        raise RunnerError("SFT 转换后的完整参数键或 shape 不匹配固定 DiffSynth DiT")
    modules = dict(model.named_modules())
    if any(name not in modules or not isinstance(modules[name], torch.nn.Linear) for name in target_names):
        raise RunnerError("冻结 LoRA target modules 不属于 DiT Linear")
    model.load_state_dict(state, strict=True, assign=True)
    return model.to(device=device, dtype=torch.bfloat16).eval()


def finite(values, label):
    import torch
    if not values or any(not torch.isfinite(value).all().item() for value in values.values()):
        raise RunnerError(f"{label} 为空或包含非有限数值")


def cache_identity(manifest):
    return {"runner": RUNNER_NAME, "version": RUNNER_VERSION,
            "runner_sha256": manifest["trainer"]["runner"]["sha256"],
            "max_pixels": manifest["semantic_config"]["max_pixels"],
            "models": manifest["models"]}


class MossBackend:
    def __init__(self, manifest):
        self.manifest = manifest
        self.models = verify_models(manifest)
        root = Path(manifest["trainer"]["root"]).resolve()
        sys.path.insert(0, str(root))
        os.environ["DIFFSYNTH_SKIP_DOWNLOAD"] = "True"
        os.environ["HF_HUB_OFFLINE"] = "1"
        os.environ["TOKENIZERS_PARALLELISM"] = "false"
        self.tokenizer = os.path.commonpath([str(Path(p).parent) for p in self.models["tokenizer"]])
        import diffsynth
        if not Path(diffsynth.__file__).resolve().is_relative_to(root):
            raise RunnerError("加载的 DiffSynth 不属于冻结训练器目录")
        self.pipe = None

    def begin_cache(self, stage):
        import torch
        from diffsynth.core import UnifiedDataset
        from diffsynth.pipelines.moss_image import MOSSImagePipeline, ModelConfig, MOSSImageUnit_PromptEmbedder
        if stage == "vae":
            self.pipe = MOSSImagePipeline.from_pretrained(torch_dtype=torch.float32, device="cuda",
                model_configs=[ModelConfig(path=self.models["vae"], skip_download=True)], tokenizer_config=None)
            self.pipe.vae.requires_grad_(False)
            self.transform = UnifiedDataset.default_image_operator(base_path=self.manifest["paths"]["inputs_dir"],
                max_pixels=self.manifest["semantic_config"]["max_pixels"], height_division_factor=16, width_division_factor=16)
        else:
            self.pipe = MOSSImagePipeline.from_pretrained(torch_dtype=torch.bfloat16, device="cuda",
                model_configs=[ModelConfig(path=self.models["text_encoder"], skip_download=True)],
                tokenizer_config=ModelConfig(path=self.tokenizer, skip_download=True))
            self.pipe.text_encoder.requires_grad_(False)
            self.embedder = MOSSImageUnit_PromptEmbedder()

    def encode(self, stage, image, caption):
        import torch
        with torch.no_grad():
            if stage == "vae":
                transformed = self.transform(str(image))
                return {"input_latents": self.pipe.vae.encode(self.pipe.preprocess_image(transformed).to("cuda", dtype=torch.float32))}
            return self.embedder.process(self.pipe, caption, 4096)

    def end_cache(self):
        import torch
        self.pipe = None
        gc.collect()
        torch.cuda.empty_cache()

    def build_model(self, device="cuda"):
        import torch
        root = Path(self.manifest["trainer"]["root"])
        spec = importlib.util.spec_from_file_location("storycanvas_frozen_moss_train", root / "examples/moss_image/model_training/train.py")
        upstream = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(upstream)
        paths = self.models["dit"]

        class FrozenSFTTrainingModule(upstream.MOSSImageTrainingModule):
            def parse_model_configs(self, *args, **kwargs):
                return []

            def split_pipeline_units(self, task, pipe, trainable_models, lora_base_model):
                pipe.dit = load_sft_dit(paths, sc["lora_target_modules"], pipe.device)
                return super().split_pipeline_units(task, pipe, trainable_models, lora_base_model)

        sc = self.manifest["semantic_config"]
        model = FrozenSFTTrainingModule(model_paths=json.dumps([paths]), tokenizer_path=self.tokenizer,
            lora_base_model="dit", lora_target_modules=",".join(sc["lora_target_modules"]), lora_rank=sc["network_dim"],
            use_gradient_checkpointing=sc.get("gradient_checkpointing", True),
            use_gradient_checkpointing_offload=sc.get("activation_cpu_offload", True), device=device, task="sft:train")
        model.train()
        parameters = [(name, parameter) for name, parameter in model.named_parameters() if parameter.requires_grad]
        if not parameters or any(not name.startswith("pipe.dit.") or "lora_" not in name for name, _ in parameters):
            raise RunnerError("可训练参数超出 DiT LoRA")
        for _, parameter in parameters:
            parameter.data = parameter.data.to(dtype=torch.float32)
        return model

    def loss(self, model, tensors):
        latent = tensors["input_latents"]
        sc = self.manifest["semantic_config"]
        shared = {"input_latents": latent, "height": latent.shape[-2] * 16, "width": latent.shape[-1] * 16,
                  "cfg_scale": 1, "rand_device": "cuda", "use_gradient_checkpointing": sc.get("gradient_checkpointing", True),
                  "use_gradient_checkpointing_offload": sc.get("activation_cpu_offload", True)}
        positive = {key: tensors[key] for key in ("prompt_embeds", "prompt_embeds_mask")}
        return model({}, inputs=(shared, positive, {"negative_prompt": "", "skip_layers": (22,)}))


def run_cache(manifest, backend=None, events=None):
    from safetensors.torch import load_file, save_file
    validate_manifest(manifest)
    events = events or Events(manifest["paths"]["events_file"])
    cache_dir = Path(manifest["paths"]["cache_dir"])
    cache_dir.mkdir(parents=True, exist_ok=True)
    stop = Path(manifest["paths"]["control_dir"]) / "stop.json"
    record = {"identity": cache_identity(manifest), "complete": False, "items": {}}
    atomic_json(cache_dir / "cache-manifest.json", record)
    events.emit("phase", phase="cache", status="begin")
    started = time.perf_counter()
    backend = backend or MossBackend(manifest)
    items = sorted(manifest["items"], key=lambda item: item["item_id"])
    done = 0
    for stage in ("vae", "text"):
        if stop.exists():
            events.emit("end", phase="cache", status="stopped")
            return "stopped"
        backend.begin_cache(stage)
        try:
            for index, item in enumerate(items):
                if stop.exists():
                    events.emit("end", phase="cache", status="stopped")
                    return "stopped"
                image, caption = verify_inputs(manifest, item)
                values = backend.encode(stage, image, caption)
                target = cache_dir / f"item-{index:06d}.safetensors"
                if stage == "text":
                    values.update(load_file(str(target), device="cpu"))
                values = {key: tensor.detach().cpu().contiguous() for key, tensor in values.items()}
                finite(values, "缓存")
                temporary = target.with_suffix(".tmp")
                save_file(values, str(temporary))
                os.replace(temporary, target)
                if stage == "text":
                    record["items"][item["item_id"]] = {"file": target.name, "sha256": sha256(target),
                        "image_sha256": item["image_sha256"], "caption_sha256": item["caption_sha256"]}
                done += 1
                events.emit("cache_progress", done=done, total=len(items) * 2, stage=stage)
        finally:
            backend.end_cache()
    record["complete"] = True
    atomic_json(cache_dir / "cache-manifest.json", record)
    events.emit("phase", phase="cache", status="end", seconds=time.perf_counter() - started)
    events.emit("end", phase="cache", status="completed")
    return "completed"


def validate_cache(manifest):
    root = Path(manifest["paths"]["cache_dir"])
    record = json.loads((root / "cache-manifest.json").read_text(encoding="utf-8"))
    if record.get("complete") is not True or record.get("identity") != cache_identity(manifest):
        raise RunnerError("缓存未完成或不属于当前冻结模型/配方")
    if set(record["items"]) != {item["item_id"] for item in manifest["items"]}:
        raise RunnerError("缓存素材列表不一致")
    result = {}
    for item in manifest["items"]:
        verify_inputs(manifest, item)
        entry = record["items"][item["item_id"]]
        path = child_path(root, entry["file"])
        if (entry["image_sha256"] != item["image_sha256"] or entry["caption_sha256"] != item["caption_sha256"]
                or sha256(path) != entry["sha256"]):
            raise RunnerError(f"缓存 hash 不符：{item['item_id']}")
        result[item["item_id"]] = path
    return result


class WeightedSampler:
    def __init__(self, weights, seed):
        self.base = [entry["item_id"] for entry in weights for _ in range(entry["weight"])]
        self.random = random.Random(seed)
        self.pending = []

    def next(self):
        if not self.pending:
            self.pending = list(self.base)
            self.random.shuffle(self.pending)
        return self.pending.pop()


def publish_checkpoint(manifest, model, step, events):
    from safetensors.torch import load_file, save_file
    raw = model.export_trainable_state_dict(model.state_dict(), remove_prefix="pipe.dit.")
    if not raw or any(key.startswith("pipe.") or "lora_" not in key for key in raw):
        raise RunnerError("导出参数不是纯 DiT LoRA")
    state = {"diffusion_model." + key: value.detach().cpu().contiguous().clone() for key, value in raw.items()}
    finite(state, "LoRA checkpoint")
    root = Path(manifest["paths"]["checkpoints_dir"])
    root.mkdir(parents=True, exist_ok=True)
    path = root / f"step-{step:06d}.safetensors"
    temporary = path.with_suffix(".tmp")
    save_file(state, str(temporary), metadata={"family": "moss-image", "step": str(step),
        "base_models": json.dumps([{"relative_path": entry["relative_path"], "sha256": entry["sha256"]}
                                   for entry in manifest["models"] if entry["kind"] == "dit"], separators=(",", ":")),
        "ss_network_dim": str(manifest["semantic_config"]["network_dim"]),
        "ss_network_alpha": str(manifest["semantic_config"]["network_alpha"])})
    finite(load_file(str(temporary)), "checkpoint 回读")
    digest = sha256(temporary)
    os.replace(temporary, path)
    events.emit("checkpoint", step=step, file=str(path), sha256=digest, size_bytes=path.stat().st_size)


def run_train(manifest, backend=None, events=None):
    import numpy as np
    import torch
    from safetensors.torch import load_file
    validate_manifest(manifest)
    events = events or Events(manifest["paths"]["events_file"])
    paths, sc, run = manifest["paths"], manifest["semantic_config"], manifest["run"]
    stop = Path(paths["control_dir"]) / "stop.json"
    cache = validate_cache(manifest)
    events.emit("phase", phase="train", status="begin")
    if stop.exists():
        events.emit("end", phase="train", status="stopped")
        return "stopped"
    seed = int(manifest.get("seed", run.get("seed", 42)))
    random.seed(seed)
    np.random.seed(seed)
    torch.manual_seed(seed)
    torch.cuda.manual_seed_all(seed)
    backend = backend or MossBackend(manifest)
    model = backend.build_model()
    parameters = [p for p in model.parameters() if p.requires_grad]
    optimizer_config, scheduler_config = sc["optimizer"], sc["scheduler"]
    optimizer = torch.optim.AdamW(parameters, lr=sc["learning_rate"], betas=tuple(optimizer_config["betas"]),
                                 eps=optimizer_config["eps"], weight_decay=optimizer_config["weight_decay"])
    scheduler = torch.optim.lr_scheduler.ConstantLR(optimizer, factor=scheduler_config["factor"], total_iters=scheduler_config["total_iters"])
    sampler = WeightedSampler(manifest["sampling"]["weights"], seed)
    accum, last_saved, samples_seen = sc["gradient_accumulation_steps"], 0, 0
    status, started = "completed", time.perf_counter()
    optimizer.zero_grad(set_to_none=True)
    for step in range(1, run["max_train_steps"] + 1):
        step_started, total_loss = time.perf_counter(), 0.0
        for _ in range(accum):
            tensors = load_file(str(cache[sampler.next()]), device="cpu")
            loss = backend.loss(model, tensors)
            if not torch.isfinite(loss).item():
                raise RunnerError("训练 loss 非有限数值")
            total_loss += float(loss.detach().item())
            (loss / accum).backward()
        finite({str(i): p.grad for i, p in enumerate(parameters) if p.grad is not None}, "LoRA 梯度")
        optimizer.step()
        scheduler.step()
        optimizer.zero_grad(set_to_none=True)
        samples_seen += accum
        events.emit("optimizer_step", step=step, target=run["max_train_steps"], loss=total_loss / accum,
                    lr=scheduler.get_last_lr()[0], samples_seen=samples_seen, seconds=time.perf_counter() - step_started)
        stopping = stop.exists()
        if step % run["save_every_n_steps"] == 0 or step == run["max_train_steps"] or stopping:
            publish_checkpoint(manifest, model, step, events)
            last_saved = step
        if stopping:
            status = "stopped"
            break
    events.emit("phase", phase="train", status="end", seconds=time.perf_counter() - started)
    events.emit("end", phase="train", status=status, step=last_saved, samples_seen=samples_seen)
    return status


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--phase", required=True, choices=("cache", "train"))
    args = parser.parse_args()
    events = None
    try:
        manifest = json.loads(Path(args.manifest).read_text(encoding="utf-8-sig"))
        events = Events(manifest["paths"]["events_file"])
        if manifest["trainer"]["runner"]["sha256"] != sha256(__file__):
            raise RunnerError("当前 runner 与冻结 SHA256 不符；请重新预检并创建训练 run")
        (run_cache if args.phase == "cache" else run_train)(manifest, events=events)
    except Exception as error:
        if events:
            events.emit("error", message=str(error))
        raise


if __name__ == "__main__":
    main()
