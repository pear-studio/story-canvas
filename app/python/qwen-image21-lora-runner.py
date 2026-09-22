"""Qwen-Image-2.1 LoRA 训练 runner（manifest v5，两阶段 cache/train 独立进程）。

契约：docs/reference/lora-training.md（settings/manifest v5、两阶段、恢复与续训）。
训练语义对齐固定 DiffSynth-Studio（library/lora-training/diffsynth.json 锁定 commit）：
- examples/qwen_image_21/model_training/train.py（QwenImage21TrainingModule、BF16、processor_path、
  max_pixels、remove_prefix_in_ckpt=pipe.dit.、use_gradient_checkpointing、initialize_model_on_cpu）
- diffsynth/diffusion/runner.py（AdamW + ConstantLR、step→scheduler.step→zero_grad 顺序）
不经过 accelerate；更新步、采样、保存、恢复、事件由本文件自管。
"""
import argparse, hashlib, importlib.util, json, math, os, pathlib, random, shutil, sys, time, traceback, subprocess, threading

import numpy as np
import torch

RUNNER_NAME = "qwen-image21-lora-runner"
RUNNER_VERSION = 1
REPO_ROOT = pathlib.Path(__file__).resolve().parents[2]
LORA_PREFIX = "pipe.dit."  # 上游 remove_prefix_in_ckpt
TOY_DIM = 8
RESOURCE_MONITOR = None


class ResourceMonitor:
    """每秒采样整卡/进程指标；采样失败不影响训练，不将缺失值当作零。"""
    def __init__(self):
        self.peaks = {}
        self.stop = threading.Event()
        self.thread = threading.Thread(target=self.run, daemon=True)
        self.thread.start()

    def run(self):
        import psutil
        process = psutil.Process()
        while not self.stop.is_set():
            try:
                self.peaks['process_peak_rss_bytes'] = max(self.peaks.get('process_peak_rss_bytes', 0), process.memory_info().rss)
                self.peaks['system_peak_used_bytes'] = max(self.peaks.get('system_peak_used_bytes', 0), psutil.virtual_memory().used)
                result = subprocess.run(['nvidia-smi', '--query-gpu=memory.used,utilization.gpu,power.draw', '--format=csv,noheader,nounits'], capture_output=True, text=True, timeout=5, creationflags=0x08000000 if os.name == 'nt' else 0)
                values = result.stdout.strip().splitlines()[0].split(',')
                for key, value, scale in zip(['gpu_peak_used_bytes', 'gpu_peak_util_percent', 'gpu_peak_power_w'], values, [2**20, 1, 1]):
                    try:
                        self.peaks[key] = max(self.peaks.get(key, 0), float(value) * scale)
                    except ValueError:
                        pass
            except Exception:
                pass
            self.stop.wait(1)


class RunnerError(Exception):
    pass


def _sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _canonical_sha256(obj):
    return hashlib.sha256(json.dumps(obj, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode("utf-8")).hexdigest()


def _atomic_json(path, obj):
    path = pathlib.Path(path)
    tmp = path.with_name(f".tmp-{path.name}-{os.getpid()}")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    # Windows 扫描器/短暂读取句柄可能阻止 replace；仅对共享冲突有界重试。
    for attempt in range(6):
        try:
            os.replace(tmp, path)
            break
        except PermissionError:
            if attempt == 5:
                raise
            time.sleep(0.05 * (attempt + 1))


def _jsonify(value):  # tuple -> list，供 JSON 存放 random 状态
    return [_jsonify(v) for v in value] if isinstance(value, tuple) else value


def _tuples(value):  # random.setstate 需要嵌套 tuple
    return tuple(_tuples(v) for v in value) if isinstance(value, list) else value


def _check_finite(state_dict, label):
    for key, tensor in state_dict.items():
        if not torch.isfinite(tensor).all().item():
            raise RunnerError(f"{label} 包含非有限张量：{key}")


def _hook(hooks, name, *args):
    fn = (hooks or {}).get(name)
    if fn:
        fn(*args)


def _perf_counters():
    # 监控缺失不填 0：无 CUDA 时不出现在事件里
    if torch.cuda.is_initialized():
        return {"torch_peak_allocated_bytes": torch.cuda.max_memory_allocated(),
                "torch_peak_reserved_bytes": torch.cuda.max_memory_reserved()}
    return {}


class Events:
    def __init__(self, path):
        self.path = pathlib.Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, event, **data):
        if event == 'end':
            data['performance'] = {**(dict(RESOURCE_MONITOR.peaks) if RESOURCE_MONITOR else {}), **_perf_counters()}
        with self.path.open("a", encoding="utf-8") as f:
            f.write(json.dumps({"v": 1, "event": event, "time": time.time(), **data}, ensure_ascii=False) + "\n")


class WeightedSampler:
    """random.Random(seed) 单实例逐轮 shuffle 加权索引；游标 (round, position)，可跨轮次边界。"""

    def __init__(self, base, seed):
        self.base = list(base)
        self.rng = random.Random(seed)
        self.round = 0
        self.order = self.base.copy()
        self.rng.shuffle(self.order)
        self.position = 0

    def next(self):
        if self.position >= len(self.order):
            self.round += 1
            self.order = self.base.copy()
            self.rng.shuffle(self.order)
            self.position = 0
        index = self.order[self.position]
        self.position += 1
        return index

    def state(self):
        return {"round": self.round, "position": self.position, "order": list(self.order),
                "random_state": _jsonify(self.rng.getstate())}

    @classmethod
    def from_state(cls, base, state):
        self = cls.__new__(cls)
        self.base = list(base)
        self.rng = random.Random()
        self.rng.setstate(_tuples(state["random_state"]))
        self.round, self.position = state["round"], state["position"]
        self.order = list(state["order"])
        return self


def trainable_state_dict(model, remove_prefix=None):
    # 同上游 DiffusionTrainingModule.export_trainable_state_dict
    names = {name for name, p in model.named_parameters() if p.requires_grad}
    state = {k: v for k, v in model.state_dict().items() if k in names}
    if remove_prefix:
        state = {(k[len(remove_prefix):] if k.startswith(remove_prefix) else k): v for k, v in state.items()}
    return {k: v.detach().cpu().contiguous() for k, v in state.items()}


def load_trainable_state_dict(model, state):
    expected = {name for name, p in model.named_parameters() if p.requires_grad}
    if expected != set(state):
        raise RunnerError("LoRA 恢复参数集合与当前模型不一致，拒绝部分加载")
    missing, unexpected = model.load_state_dict(state, strict=False)
    if unexpected:
        raise RunnerError(f"LoRA 状态包含 {len(unexpected)} 个未知键（如 {unexpected[0]}），拒绝加载")


class ToyBackend:
    """CPU 合成后端：固定形状小网络 + 确定性合成 cache；复用同一套循环/采样/保存/恢复/事件路径。"""

    def __init__(self, manifest, phase):
        self.model = _ToyModule() if phase == "train" else None

    def encode_item(self, item, image_path, caption):
        g = torch.Generator().manual_seed(int(item["image_sha256"][:16], 16))
        x = torch.randn(TOY_DIM, generator=g)
        y = torch.randn(TOY_DIM, generator=g)
        return ({"x": x, "y": y}, {}, {})

    def forward_loss(self, data):
        shared = data[0]
        noise = 0.01 * torch.randn_like(shared["x"])  # 消耗全局 torch RNG，对齐上游 loss 内采样语义
        pred = self.model.pipe.dit(shared["x"] + noise)
        return torch.nn.functional.mse_loss(pred, shared["y"])


class _ToyDit(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.net = torch.nn.Sequential(torch.nn.Linear(TOY_DIM, 16), torch.nn.Tanh(), torch.nn.Linear(16, TOY_DIM))

    def forward(self, x):
        return self.net(x)


class _ToyModule(torch.nn.Module):
    # 键前缀 pipe.dit.，与真实 backend 的导出/加载路径一致
    def __init__(self):
        super().__init__()
        self.pipe = torch.nn.Module()
        self.pipe.dit = _ToyDit()


class QwenBackend:
    """真实后端：sys.path 插入固定 trainer_root 后复用上游 QwenImage21TrainingModule。"""

    def __init__(self, manifest, phase):
        if not torch.cuda.is_available():
            raise RunnerError("真实训练后端需要可用 CUDA；无 GPU 验证请使用 --backend toy")
        config = json.loads((REPO_ROOT / "Config" / "local.json").read_text(encoding="utf-8"))
        diffsynth = config["lora_training"]["diffsynth"]
        trainer_root = pathlib.Path(os.environ.get("STORY_CANVAS_DIFFSYNTH_ROOT") or diffsynth["trainer_root"])
        # models_root 以冻结 manifest 为准，local.json 只提供训练器环境路径
        models_root = pathlib.Path(manifest["paths"]["models_root"])
        os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
        os.environ.setdefault("HF_HUB_OFFLINE", "1")
        os.environ.setdefault("DIFFSYNTH_SKIP_DOWNLOAD", "true")
        if str(trainer_root) not in sys.path:
            sys.path.insert(0, str(trainer_root))
        entry = trainer_root / "examples/qwen_image_21/model_training/train.py"
        spec = importlib.util.spec_from_file_location("qwen_image21_train", entry)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        sc = manifest["semantic_config"]
        kinds = ["text_encoder", "vae"] if phase == "cache" else ["dit"]
        model_paths = self._model_paths(manifest, models_root, kinds)
        processor_path = self._processor_path(manifest, models_root)
        self.model = module.QwenImage21TrainingModule(
            model_paths=json.dumps(model_paths, ensure_ascii=False),
            processor_path=processor_path,
            lora_base_model="dit",
            lora_target_modules=",".join(sc["lora_target_modules"]),  # manifest 冻结清单，不再自动探测
            lora_rank=sc["network_dim"],
            use_gradient_checkpointing=bool(sc.get("gradient_checkpointing", True)),
            device="cpu",  # 上游 --initialize_model_on_cpu 语义
            task="sft:data_process" if phase == "cache" else "sft:train",
        )
        self.model.to("cuda")
        if phase == "cache":
            from diffsynth.core import UnifiedDataset
            self.image_operator = UnifiedDataset.default_image_operator(
                base_path="", max_pixels=sc["max_pixels"], height=None, width=None,
                height_division_factor=32, width_division_factor=32, convert_RGB=False, convert_RGBA=True)

    @staticmethod
    def _model_paths(manifest, models_root, kinds):
        grouped = {kind: [] for kind in kinds}
        for entry in manifest["models"]:
            # 模型清单还包含 config/index JSON；它们参与身份校验，但不是权重 shard。
            if entry["kind"] in grouped and entry["relative_path"].endswith('.safetensors'):
                path = models_root / entry["relative_path"]
                if not path.is_file() or path.stat().st_size != entry["size_bytes"]:
                    raise RunnerError(f"模型文件缺失或尺寸不符：{path}")
                grouped[entry["kind"]].append(str(path))
        paths = []
        for kind in kinds:
            files = sorted(grouped[kind])
            if not files:
                raise RunnerError(f"manifest.models 缺少 {kind}")
            paths.append(files[0] if len(files) == 1 else files)
        return paths

    @staticmethod
    def _processor_path(manifest, models_root):
        files = [models_root / e["relative_path"] for e in manifest["models"] if e["kind"] == "processor"]
        if not files:
            raise RunnerError("manifest.models 缺少 processor")
        parents = {str(p.parent) for p in files}
        if len(parents) != 1:
            raise RunnerError("processor 文件不在同一目录")
        return parents.pop()

    def encode_item(self, item, image_path, caption):
        data = {"prompt": caption, "image": self.image_operator(str(image_path))}
        with torch.no_grad():
            return self.model(data)  # sft:data_process 返回 (inputs_shared, inputs_posi, inputs_nega)

    def forward_loss(self, data):
        return self.model({}, inputs=data)  # 上游 runner.py 的 load_from_cache 分支


def build_backend(manifest, phase, backend):
    return ToyBackend(manifest, phase) if backend == "toy" else QwenBackend(manifest, phase)


def _semantic_fingerprint(manifest):
    items = sorted(({"item_id": i["item_id"], "image_sha256": i["image_sha256"], "caption_sha256": i["caption_sha256"]}
                    for i in manifest["items"]), key=lambda i: i["item_id"])
    weights = sorted(manifest["sampling"]["weights"], key=lambda w: w["item_id"])
    return _canonical_sha256({"semantic_config": manifest["semantic_config"], "items": items,
                              "weights": weights, "seed": manifest.get("seed")})


def _cache_models_identity(manifest):
    entries = [e for e in manifest.get("models", []) if e["kind"] in ("text_encoder", "vae", "processor")]
    return sorted(({"kind": e["kind"], "relative_path": e["relative_path"], "sha256": e["sha256"], "size_bytes": e["size_bytes"]}
                   for e in entries), key=lambda e: (e["kind"], e["relative_path"]))


def _verify_item_inputs(inputs_dir, item):
    image_path = pathlib.Path(inputs_dir) / item["image_file"]
    caption_path = pathlib.Path(inputs_dir) / item["caption_file"]
    if not image_path.is_file() or _sha256_file(image_path) != item["image_sha256"]:
        raise RunnerError(f"图片缺失或 hash 不符：{image_path}")
    if not caption_path.is_file():
        raise RunnerError(f"Caption 缺失：{caption_path}")
    caption_bytes = caption_path.read_bytes()
    if hashlib.sha256(caption_bytes).hexdigest() != item["caption_sha256"]:
        raise RunnerError(f"Caption hash 不符：{caption_path}")
    return image_path, caption_bytes.decode("utf-8")


def run_cache(manifest, backend="qwen", events=None, hooks=None):
    paths, sc = manifest["paths"], manifest["semantic_config"]
    cache_dir, inputs_dir = pathlib.Path(paths["cache_dir"]), pathlib.Path(paths["inputs_dir"])
    cache_dir.mkdir(parents=True, exist_ok=True)
    stop_file = pathlib.Path(paths["control_dir"]) / "stop.json"
    events = events or Events(paths["events_file"])
    items = sorted(manifest["items"], key=lambda i: i["item_id"])  # 缓存确定性：固定 item_id 序
    events.emit("phase", phase="cache", status="begin", total=len(items))
    started = time.perf_counter()
    backend_obj = build_backend(manifest, "cache", backend)
    record_path = cache_dir / "cache-manifest.json"
    record = json.loads(record_path.read_text(encoding="utf-8")) if record_path.is_file() else {}
    identity = {"runner": {"name": RUNNER_NAME, "version": RUNNER_VERSION},
                "max_pixels": sc["max_pixels"], "models": _cache_models_identity(manifest)}
    previous = record.get("items", {}) if all(record.get(k) == v for k, v in identity.items()) else {}
    out = {"v": 1, **identity, "items": dict(previous), "complete": False}
    status, done = "completed", 0
    for item in items:
        if stop_file.exists():  # item 边界停止，不写训练恢复点
            status = "stopped"
            break
        image_path, caption = _verify_item_inputs(inputs_dir, item)
        cache_file = cache_dir / f"{item['item_id']}.pth"
        entry = previous.get(item["item_id"])
        skipped = (entry is not None and entry["image_sha256"] == item["image_sha256"]
                   and entry["caption_sha256"] == item["caption_sha256"] and cache_file.is_file()
                   and _sha256_file(cache_file) == entry["sha256"])
        if not skipped:
            cache_seed = int(item["image_sha256"][:16], 16) % (2**32)
            random.seed(cache_seed)
            np.random.seed(cache_seed)
            torch.manual_seed(cache_seed)
            data = backend_obj.encode_item(item, image_path, caption)
            tmp = cache_dir / f".tmp-{item['item_id']}-{os.getpid()}.pth"
            torch.save(data, tmp)
            os.replace(tmp, cache_file)
            out["items"][item["item_id"]] = {"file": cache_file.name, "image_sha256": item["image_sha256"],
                                             "caption_sha256": item["caption_sha256"], "sha256": _sha256_file(cache_file)}
            _atomic_json(record_path, out)  # 逐项落盘，中断后可跳过已完成项
        done += 1
        _hook(hooks, "cache_item", item["item_id"], skipped)
        events.emit("cache_progress", done=done, total=len(items), item_id=item["item_id"], skipped=skipped)
    out["complete"] = status == "completed"
    _atomic_json(record_path, out)
    seconds = time.perf_counter() - started
    events.emit("phase", phase="cache", status="end", seconds=seconds)
    events.emit("end", status=status, phase="cache", seconds=seconds, **_perf_counters())
    return status


def _validate_cache(manifest):
    paths, sc = manifest["paths"], manifest["semantic_config"]
    record_path = pathlib.Path(paths["cache_dir"]) / "cache-manifest.json"
    if not record_path.is_file():
        raise RunnerError(f"缓存清单缺失：{record_path}（先运行 cache 阶段）")
    record = json.loads(record_path.read_text(encoding="utf-8"))
    if not record.get("complete"):
        raise RunnerError("缓存清单未完整完成")
    if record.get("runner", {}).get("name") != RUNNER_NAME or record.get("runner", {}).get("version") != RUNNER_VERSION:
        raise RunnerError("缓存 runner 身份不符")
    if record.get("max_pixels") != sc["max_pixels"] or record.get("models") != _cache_models_identity(manifest):
        raise RunnerError("缓存身份（max_pixels/模型）与 manifest 不符")
    items = {i["item_id"]: i for i in manifest["items"]}
    for w in manifest["sampling"]["weights"]:
        item = items.get(w["item_id"])
        entry = record.get("items", {}).get(w["item_id"])
        if item is None or entry is None or entry["image_sha256"] != item["image_sha256"] or entry["caption_sha256"] != item["caption_sha256"]:
            raise RunnerError(f"缓存与 manifest 不匹配：{w['item_id']}")
        if not (record_path.parent / entry["file"]).is_file():
            raise RunnerError(f"缓存文件缺失：{entry['file']}")


def _publish_checkpoint(manifest, model, step, events):
    checkpoints_dir = pathlib.Path(manifest["paths"]["checkpoints_dir"])
    checkpoints_dir.mkdir(parents=True, exist_ok=True)
    name = f"step-{step:06d}.safetensors"
    state = trainable_state_dict(model, remove_prefix=LORA_PREFIX)  # 导出键去 pipe.dit. 前缀，与上游一致
    _check_finite(state, "checkpoint")
    tmp = checkpoints_dir / f".tmp-{name}-{os.getpid()}"
    from safetensors.torch import save_file, load_file
    save_file(state, str(tmp))
    _check_finite(load_file(str(tmp)), "checkpoint 回读")
    sha256 = _sha256_file(tmp)
    final = checkpoints_dir / name
    os.replace(tmp, final)
    events.emit("checkpoint", step=step, file=str(final), sha256=sha256, size_bytes=final.stat().st_size)


def _publish_resume(manifest, model, optimizer, scheduler, sampler, step, samples_seen, fingerprint, events):
    resume_dir = pathlib.Path(manifest["paths"]["resume_dir"])
    resume_dir.mkdir(parents=True, exist_ok=True)
    snapshot_id = f"step-{step:06d}"
    final = resume_dir / snapshot_id
    if final.exists():
        raise RunnerError(f"恢复快照已存在（runner 不覆盖旧包）：{final}")
    tmp = resume_dir / f".tmp-{snapshot_id}-{os.getpid()}"
    if tmp.exists():
        shutil.rmtree(tmp)  # 仅限本 runner 命名规则的残留临时目录
    tmp.mkdir(parents=True)
    from safetensors.torch import save_file, load_file
    lora = trainable_state_dict(model)  # 保留 pipe.dit. 前缀的完整可加载态
    _check_finite(lora, "resume lora")
    save_file(lora, str(tmp / "lora.safetensors"))
    optimizer_state = optimizer.state_dict()
    for index, values in optimizer_state['state'].items():
        _check_finite({str(k): v for k, v in values.items() if isinstance(v, torch.Tensor)}, f'optimizer {index}')
    torch.save(optimizer_state, tmp / "optimizer.pt")
    torch.save(scheduler.state_dict(), tmp / "scheduler.pt")
    rng = {"python": random.getstate(), "numpy": np.random.get_state(), "torch_cpu": torch.get_rng_state(),
           "torch_cuda": torch.cuda.get_rng_state_all() if torch.cuda.is_initialized() else None}
    torch.save(rng, tmp / "rng.pt")
    (tmp / "sampler.json").write_text(json.dumps(sampler.state(), ensure_ascii=False), encoding="utf-8")
    names = ["lora.safetensors", "optimizer.pt", "scheduler.pt", "rng.pt", "sampler.json"]
    state = {"v": 1, "snapshot_id": snapshot_id, "step": step, "samples_seen": samples_seen,
             "semantic_fingerprint": fingerprint,
             "trainer": {"diffsynth_commit": manifest["trainer"]["diffsynth_commit"],
                         "runner": {"name": RUNNER_NAME, "version": RUNNER_VERSION}},
             "files": {name: _sha256_file(tmp / name) for name in names}}
    (tmp / "state.json").write_text(json.dumps(state, ensure_ascii=False, indent=2), encoding="utf-8")
    # 发布前校验：文件齐全、hash 一致、可重载且张量有限
    for name, sha256 in state["files"].items():
        if _sha256_file(tmp / name) != sha256:
            raise RunnerError(f"恢复包校验失败：{name}")
    _check_finite(load_file(str(tmp / "lora.safetensors")), "resume lora 回读")
    torch.load(tmp / "optimizer.pt", weights_only=False)
    torch.load(tmp / "scheduler.pt", weights_only=False)
    torch.load(tmp / "rng.pt", weights_only=False)
    os.rename(tmp, final)  # 临时目录写齐校验后 rename 发布；失败时旧包不受影响
    state_sha256 = _sha256_file(final / "state.json")
    _atomic_json(resume_dir / "latest.json", {"snapshot_id": snapshot_id, "step": step, "sha256": state_sha256})
    events.emit("resume_saved", snapshot_id=snapshot_id, step=step, sha256=state_sha256)


def _restore(manifest, model, optimizer, scheduler, fingerprint, base):
    info = manifest["resume"]
    snapshot_id = info["source_snapshot_id"]
    snapshot = pathlib.Path(manifest["paths"]["resume_dir"]) / snapshot_id
    state_file = snapshot / "state.json"
    if not state_file.is_file():
        raise RunnerError(f"恢复快照缺失：{snapshot}，拒绝恢复")
    if _sha256_file(state_file) != info["source_sha256"]:
        raise RunnerError("state.json 与 manifest 登记的 source_sha256 不符，拒绝恢复")
    state = json.loads(state_file.read_text(encoding="utf-8"))
    if state.get("step") != info["start_step"]:
        raise RunnerError(f"恢复起点不符：state.step={state.get('step')} != {info['start_step']}")
    if state.get("semantic_fingerprint") != fingerprint:
        raise RunnerError("语义配置指纹不符，拒绝恢复")
    if state["trainer"]["diffsynth_commit"] != manifest["trainer"]["diffsynth_commit"]:
        raise RunnerError("trainer commit 不符，拒绝恢复")
    if state["trainer"]["runner"] != {"name": RUNNER_NAME, "version": RUNNER_VERSION}:
        raise RunnerError("runner 身份不符，拒绝恢复")
    for name, sha256 in state["files"].items():
        file = snapshot / name
        if not file.is_file() or _sha256_file(file) != sha256:
            raise RunnerError(f"恢复包文件缺失或 hash 不符：{name}，拒绝恢复")
    from safetensors.torch import load_file
    lora = load_file(str(snapshot / "lora.safetensors"))
    _check_finite(lora, "resume lora")
    load_trainable_state_dict(model, lora)
    optimizer.load_state_dict(torch.load(snapshot / "optimizer.pt", weights_only=False))
    scheduler.load_state_dict(torch.load(snapshot / "scheduler.pt", weights_only=False))
    rng = torch.load(snapshot / "rng.pt", weights_only=False)  # 续训不重置 RNG
    random.setstate(_tuples(rng["python"]))
    np.random.set_state(rng["numpy"])
    torch.set_rng_state(rng["torch_cpu"])
    if rng.get("torch_cuda") is not None and torch.cuda.is_available():
        torch.cuda.set_rng_state_all(rng["torch_cuda"])
    sampler_state = json.loads((snapshot / "sampler.json").read_text(encoding="utf-8"))
    sampler = WeightedSampler.from_state(base, sampler_state)
    return state["step"], state["samples_seen"], sampler


def run_train(manifest, backend="qwen", events=None, hooks=None):
    paths, sc, run = manifest["paths"], manifest["semantic_config"], manifest["run"]
    seed = manifest.get("seed", run.get("seed"))
    accum = sc["gradient_accumulation_steps"]
    max_steps, save_every = run["max_train_steps"], run["save_every_n_steps"]
    if accum < 1 or max_steps < 1 or save_every < 1:
        raise RunnerError("gradient_accumulation_steps/max_train_steps/save_every_n_steps 必须为正整数")
    if sc["optimizer"].get("type", "AdamW") != "AdamW" or sc["scheduler"].get("type", "ConstantLR") != "ConstantLR":
        raise RunnerError("仅支持 AdamW + ConstantLR")
    events = events or Events(paths["events_file"])
    stop_file = pathlib.Path(paths["control_dir"]) / "stop.json"
    _validate_cache(manifest)
    resuming = manifest.get("resume") is not None
    if not resuming:
        torch.manual_seed(seed)  # 先固定 LoRA 初始化随机性
    backend_obj = build_backend(manifest, "train", backend)
    model = backend_obj.model
    optimizer = torch.optim.AdamW((p for p in model.parameters() if p.requires_grad),
                                  lr=sc["learning_rate"], betas=tuple(sc["optimizer"]["betas"]),
                                  eps=sc["optimizer"]["eps"], weight_decay=sc["optimizer"]["weight_decay"])
    scheduler = torch.optim.lr_scheduler.ConstantLR(optimizer, factor=sc["scheduler"]["factor"],
                                                    total_iters=sc["scheduler"]["total_iters"])
    weights = {w["item_id"]: w["weight"] for w in manifest["sampling"]["weights"]}
    items = sorted(manifest["items"], key=lambda i: i["item_id"])
    base = [index for index, item in enumerate(items) for _ in range(weights.get(item["item_id"], 0))]
    if not base:
        raise RunnerError("加权采样清单为空")
    fingerprint = _semantic_fingerprint(manifest)
    if resuming:
        start_step, samples_seen, sampler = _restore(manifest, model, optimizer, scheduler, fingerprint, base)
    else:
        random.seed(seed)
        np.random.seed(seed)
        torch.manual_seed(seed)  # 加载/重建完成后重置训练 RNG
        if torch.cuda.is_available():
            torch.cuda.manual_seed_all(seed)
        start_step, samples_seen, sampler = 0, 0, WeightedSampler(base, seed)
    if start_step >= max_steps:
        raise RunnerError(f"恢复起点 {start_step} 已达到目标步数 {max_steps}")
    cache_dir = pathlib.Path(paths["cache_dir"])
    events.emit("phase", phase="train", status="begin", start_step=start_step, target=max_steps)
    started = time.perf_counter()
    status, step, saved_steps = "completed", start_step, set()
    while step < max_steps:
        tick = time.perf_counter()
        losses = []
        _hook(hooks, "update_begin", model)
        for _ in range(accum):
            item = items[sampler.next()]
            _hook(hooks, "sample", item["item_id"])
            data = torch.load(cache_dir / f"{item['item_id']}.pth", map_location="cpu", weights_only=False)
            _hook(hooks, "pre_forward")
            loss = backend_obj.forward_loss(data)
            value = float(loss.detach().float())
            if not math.isfinite(value):
                raise RunnerError(f"step {step + 1} 出现非有限 loss，终止训练")
            losses.append(value)
            _hook(hooks, "micro", value, value / accum)
            (loss / accum).backward()  # loss/G 归一化，只在边界更新
        _hook(hooks, "before_step", optimizer, scheduler, model)
        optimizer.step()
        scheduler.step()
        optimizer.zero_grad()
        step += 1
        samples_seen += accum
        events.emit("optimizer_step", step=step, target=max_steps, loss=sum(losses) / len(losses),
                    lr=optimizer.param_groups[0]["lr"], samples_seen=samples_seen, seconds=time.perf_counter() - tick)
        _hook(hooks, "after_update", {"step": step, "model": model, "optimizer": optimizer, "sampler": sampler})
        if step % save_every == 0:
            _publish_checkpoint(manifest, model, step, events)
            _publish_resume(manifest, model, optimizer, scheduler, sampler, step, samples_seen, fingerprint, events)
            saved_steps.add(step)
        if stop_file.exists():  # 更新边界保存后退出
            if step not in saved_steps:
                _publish_checkpoint(manifest, model, step, events)
                _publish_resume(manifest, model, optimizer, scheduler, sampler, step, samples_seen, fingerprint, events)
                saved_steps.add(step)
            status = "stopped"
            break
    if status == "completed" and step not in saved_steps:  # 正常结束额外保存最终完整状态
        _publish_checkpoint(manifest, model, step, events)
        _publish_resume(manifest, model, optimizer, scheduler, sampler, step, samples_seen, fingerprint, events)
    seconds = time.perf_counter() - started
    events.emit("phase", phase="train", status="end", seconds=seconds)
    events.emit("end", status=status, phase="train", seconds=seconds, steps_completed=step - start_step,
                samples_seen=samples_seen, **_perf_counters())
    return status


def main(argv=None):
    global RESOURCE_MONITOR
    for stream in (sys.stdout, sys.stderr):  # 日志 UTF-8，不受 Windows 控制台代码页影响
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass
    parser = argparse.ArgumentParser(description="Qwen-Image-2.1 LoRA 训练 runner")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--phase", choices=["cache", "train"], required=True)
    parser.add_argument("--backend", choices=["qwen", "toy"], default="qwen")
    args = parser.parse_args(argv)
    try:
        manifest = json.loads(pathlib.Path(args.manifest).read_text(encoding="utf-8"))
        if manifest.get("version") != 5:
            raise RunnerError(f"manifest version 必须为 5（实际 {manifest.get('version')}）")
        events = Events(manifest["paths"]["events_file"])
    except Exception as e:
        print(f"runner 启动失败：{e}", file=sys.stderr)
        return 2
    try:
        if args.backend == 'qwen':
            RESOURCE_MONITOR = ResourceMonitor()
        if args.phase == "cache":
            run_cache(manifest, backend=args.backend, events=events)
        else:
            run_train(manifest, backend=args.backend, events=events)
    except RunnerError as e:
        events.emit("error", message=str(e))
        print(f"error: {e}", file=sys.stderr)
        return 2
    except Exception:
        events.emit("error", message=traceback.format_exc())
        traceback.print_exc()
        return 2
    finally:
        if RESOURCE_MONITOR:
            RESOURCE_MONITOR.stop.set()
            RESOURCE_MONITOR.thread.join(timeout=6)
    return 0


if __name__ == "__main__":
    sys.exit(main())
