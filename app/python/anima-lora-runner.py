"""Anima manifest v5 runner；同进程调用固定 sd-scripts，不提供完整状态续训。"""
import argparse
import copy
import hashlib
import importlib
import json
import math
import os
import pathlib
import sys
import tempfile
import time
import traceback

RUNNER_NAME = "anima-lora-runner"
RUNNER_VERSION = 1


class RunnerError(Exception):
    pass


class StopRequested(Exception):
    pass


class Events:
    def __init__(self, path):
        self.path = pathlib.Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)

    def emit(self, event, **data):
        with self.path.open("a", encoding="utf-8") as stream:
            stream.write(json.dumps({"v": 1, "event": event, "time": time.time(), **data}, ensure_ascii=False) + "\n")


def sha256_file(path):
    digest = hashlib.sha256()
    with pathlib.Path(path).open("rb") as stream:
        for chunk in iter(lambda: stream.read(1 << 20), b""):
            digest.update(chunk)
    return digest.hexdigest()


def verify_inputs(manifest):
    inputs = pathlib.Path(manifest["paths"]["inputs_dir"])
    for item in manifest["items"]:
        for kind in ("image", "caption"):
            path = inputs / item[f"{kind}_file"]
            if not path.is_file() or sha256_file(path) != item[f"{kind}_sha256"]:
                raise RunnerError(f"冻结 {kind} 缺失或 hash 不符：{path}")


def stopped(manifest):
    return (pathlib.Path(manifest["paths"]["control_dir"]) / "stop.json").is_file()


def dataset_config_path(manifest):
    return pathlib.Path(manifest["paths"]["cache_dir"]) / "dataset.toml"


def prepare_dataset(manifest):
    """派生目录用硬链接；上游 npz 缓存不能写进不可变的归档 inputs。"""
    verify_inputs(manifest)
    paths, config = manifest["paths"], manifest["semantic_config"]
    weights = {entry["item_id"]: entry["weight"] for entry in manifest["sampling"]["weights"]}
    cache = pathlib.Path(paths["cache_dir"])
    cache.mkdir(parents=True, exist_ok=True)
    subsets = {}
    for item in manifest["items"]:
        weight = weights[item["item_id"]]
        if not isinstance(weight, int) or isinstance(weight, bool) or weight < 1:
            raise RunnerError("Anima repeats 必须为正整数")
        directory = cache / "subsets" / f"repeat-{weight}"
        directory.mkdir(parents=True, exist_ok=True)
        subsets[weight] = directory
        for kind in ("image", "caption"):
            source = pathlib.Path(paths["inputs_dir"]) / item[f"{kind}_file"]
            target = directory / source.name
            if target.exists():
                if not os.path.samefile(source, target):
                    raise RunnerError(f"训练派生硬链接与冻结输入不符：{target}")
            else:
                os.link(source, target)
    resolution = math.isqrt(config["max_pixels"])
    if resolution * resolution != config["max_pixels"] or resolution % 64:
        raise RunnerError("Anima max_pixels 必须对应 64 的倍数的方形基准分辨率")
    lines = ["[general]", 'caption_extension = ".txt"', "shuffle_caption = false", "",
             "[[datasets]]", f"resolution = {resolution}", f"batch_size = {config['micro_batch_size']}",
             "enable_bucket = true", "bucket_no_upscale = true", "bucket_reso_steps = 64"]
    for weight, directory in sorted(subsets.items()):
        lines.extend(["", "[[datasets.subsets]]", f"image_dir = {json.dumps(directory.as_posix(), ensure_ascii=False)}",
                      f"num_repeats = {weight}"])
    dataset_config_path(manifest).write_text("\n".join(lines) + "\n", encoding="utf-8")


def run_cache(manifest, events=None):
    events = events or Events(manifest["paths"]["events_file"])
    started = time.perf_counter()
    events.emit("phase", phase="cache", status="begin", detail="准备冻结输入；latent/TE 缓存在训练进程内执行")
    status = "stopped" if stopped(manifest) else "completed"
    if status == "completed":
        prepare_dataset(manifest)
    seconds = time.perf_counter() - started
    events.emit("phase", phase="cache", status="end", seconds=seconds)
    events.emit("end", phase="cache", status=status, seconds=seconds)
    return status


def model_paths(manifest):
    root = pathlib.Path(manifest["paths"]["models_root"])
    paths = {}
    for entry in manifest["models"]:
        path = root / entry["relative_path"]
        if not path.is_file() or path.stat().st_size != entry["size_bytes"] or sha256_file(path) != entry["sha256"]:
            raise RunnerError(f"冻结模型缺失或身份不符：{path}")
        paths[entry["kind"]] = str(path)
    return paths


def compile_arguments(manifest, models=None):
    config, run = manifest["semantic_config"], manifest["run"]
    models = models if models is not None else model_paths(manifest)
    optimizer = config["optimizer"]
    targets = config["lora_target_modules"]
    if targets != ["self_attn", "cross_attn", "mlp"]:
        raise RunnerError("当前 Anima 路线仅训练标准 DiT self_attn/cross_attn/mlp")
    patterns = [rf".*\.{name}\..*" for name in targets]
    result = ["--dataset_config", str(dataset_config_path(manifest)),
              "--output_dir", manifest["paths"]["checkpoints_dir"], "--output_name", "anima",
              "--pretrained_model_name_or_path", models["dit"], "--qwen3", models["text_encoder"], "--vae", models["vae"],
              "--network_module", "networks.lora_anima", "--network_dim", str(config["network_dim"]),
              "--network_alpha", str(config["network_alpha"]), "--network_train_unet_only",
              "--network_args", "train_llm_adapter=false", "exclude_patterns=['.*']", f"include_patterns={patterns!r}",
              "--llm_adapter_lr", "0", "--learning_rate", str(config["learning_rate"]),
              "--optimizer_type", optimizer["type"], "--optimizer_args", f"betas={tuple(optimizer['betas'])!r}",
              f"eps={optimizer['eps']}", f"weight_decay={optimizer['weight_decay']}",
              "--lr_scheduler", config["scheduler"]["type"], "--lr_warmup_steps",
              str(int(run["max_train_steps"] * config["scheduler"]["warmup_ratio"])),
              "--max_train_steps", str(run["max_train_steps"]), "--save_every_n_steps", str(run["save_every_n_steps"]),
              "--train_batch_size", str(config["micro_batch_size"]),
              "--gradient_accumulation_steps", str(config["gradient_accumulation_steps"]),
              "--mixed_precision", config["precision"]["base"], "--save_precision", config["precision"]["lora"],
              "--save_model_as", "safetensors", "--seed", str(run["seed"]),
              "--cache_latents", "--cache_latents_to_disk", "--cache_text_encoder_outputs", "--cache_text_encoder_outputs_to_disk",
              "--sdpa", "--attn_mode", "torch", "--qwen_image_vae_2d", "--vae_chunk_size", "32",
              "--max_data_loader_n_workers", "2", "--persistent_data_loader_workers",
              "--blocks_to_swap", str(config["blocks_to_swap"]),
              "--timestep_sampling", config["timestep_sampling"], "--sigmoid_scale", str(config["sigmoid_scale"]),
              "--discrete_flow_shift", "1", "--loss_type", config["loss_type"], "--weighting_scheme", config["weighting_scheme"]]
    if config["gradient_checkpointing"]:
        result.append("--gradient_checkpointing")
    return result


def trainer_class(base, manifest, events):
    """仅使用当前锁定上游的公开 callback；不改外部 trainer。"""
    class WorkbenchAnimaTrainer(base):
        def __init__(self):
            super().__init__()
            self.workbench_step = 0
            self.workbench_network = None
            self.workbench_accelerator = None
            self.workbench_losses = []
            self.workbench_tick = time.perf_counter()
            self.workbench_saved_steps = set()

        def post_process_network(self, args, accelerator, network, text_encoders, unet):
            self.workbench_network = network
            self.workbench_accelerator = accelerator
            return super().post_process_network(args, accelerator, network, text_encoders, unet)

        def on_step_start(self, args, accelerator, network, text_encoders, unet, batch, weight_dtype, is_train=True):
            self.workbench_network = network
            self.workbench_accelerator = accelerator
            return super().on_step_start(args, accelerator, network, text_encoders, unet, batch, weight_dtype, is_train=is_train)

        def process_batch(self, *args, **kwargs):
            loss = super().process_batch(*args, **kwargs)
            value = float(loss.detach().float().item())
            if not math.isfinite(value):
                raise RunnerError("Anima 训练出现非有限 loss")
            self.workbench_losses.append(value)
            return loss

        def sample_images(self, accelerator, args, epoch, global_step, *unused):
            # 未配置样图；该 callback 每次 optimizer 更新后调用，也会在 epoch 末尾重复调用。
            if global_step == 0:
                self.workbench_tick = time.perf_counter()  # 首步 ETA 不计入模型加载与缓存耗时。
            if global_step > self.workbench_step:
                tick = time.perf_counter()
                data = {"step": global_step, "target": manifest["run"]["max_train_steps"],
                        "seconds": tick - self.workbench_tick}
                if self.workbench_losses:
                    data["loss"] = sum(self.workbench_losses) / len(self.workbench_losses)
                events.emit("optimizer_step", **data)
                self.workbench_losses.clear()
                self.workbench_step = global_step
                self.workbench_tick = tick
            if stopped(manifest):
                if global_step > 0:
                    import torch
                    self._save_model(args=args, accelerator=accelerator, save_dtype=torch.bfloat16,
                                     ckpt_name=f"step-{global_step:06d}.safetensors",
                                     unwrapped_nw=accelerator.unwrap_model(self.workbench_network),
                                     steps=global_step, epoch_no=epoch or 0)
                raise StopRequested()

        def _save_model(self, **kwargs):
            step = kwargs["steps"]
            if step in self.workbench_saved_steps:
                return
            # 上游按扩展名判断保存格式；在不会被根目录清点扫描的子目录内写完整 safetensors。
            directory = pathlib.Path(kwargs["args"].output_dir)
            directory.mkdir(parents=True, exist_ok=True)
            filename = f"step-{step:06d}.safetensors"
            path = directory / filename
            if path.exists():
                raise RunnerError(f"不覆盖已发布 checkpoint：{path}")
            with tempfile.TemporaryDirectory(prefix=".publishing-", dir=directory) as staging:
                args = copy.copy(kwargs["args"])
                args.output_dir = staging
                super()._save_model(**{**kwargs, "args": args, "ckpt_name": filename})
                os.replace(pathlib.Path(staging) / filename, path)
            self.workbench_saved_steps.add(step)
            events.emit("checkpoint", step=kwargs["steps"], file=str(path), sha256=sha256_file(path), size_bytes=path.stat().st_size)

    return WorkbenchAnimaTrainer


def run_train(manifest, events=None, trainer_module=None):
    events = events or Events(manifest["paths"]["events_file"])
    if manifest.get("resume") is not None:
        raise RunnerError("Anima 当前不支持完整状态续训")
    if stopped(manifest):
        events.emit("end", phase="train", status="stopped", steps_completed=0, seconds=0)
        return "stopped"
    prepare_dataset(manifest)
    argv = compile_arguments(manifest)
    root = pathlib.Path(manifest["trainer"]["root"])
    os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")
    os.environ.setdefault("HF_HUB_OFFLINE", "1")
    sys.path.insert(0, str(root))
    module = trainer_module or importlib.import_module("anima_train_network")
    parser = module.setup_parser()
    args = parser.parse_args(argv)
    # 与上游入口执行同一参数规范检查，不调用 read_config_from_file（不使用外部配置）。
    if trainer_module is None:
        from library.args import verify_command_line_training_args
        verify_command_line_training_args(args)
    record = pathlib.Path(manifest["paths"]["archive_dir"]) / "trainer-command.json"
    record.write_text(json.dumps({"script": str(root / "anima_train_network.py"), "argv": argv}, ensure_ascii=False, indent=2), encoding="utf-8")
    trainer = trainer_class(module.AnimaNetworkTrainer, manifest, events)()
    started = time.perf_counter()
    events.emit("phase", phase="train", status="begin", start_step=0, target=manifest["run"]["max_train_steps"],
                detail="加载模型并缓存 latent/TE 后开始 optimizer 更新")
    status = "completed"
    try:
        trainer.train(args)
    except StopRequested:
        status = "stopped"
        if trainer.workbench_accelerator is not None:
            trainer.workbench_accelerator.end_training()
    seconds = time.perf_counter() - started
    events.emit("phase", phase="train", status="end", seconds=seconds)
    events.emit("end", phase="train", status=status, seconds=seconds, steps_completed=trainer.workbench_step)
    return status


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass
    parser = argparse.ArgumentParser(description="Anima LoRA manifest v5 runner")
    parser.add_argument("--manifest", required=True)
    parser.add_argument("--phase", choices=["cache", "train"], required=True)
    args = parser.parse_args(argv)
    events = None
    try:
        manifest = json.loads(pathlib.Path(args.manifest).read_text(encoding="utf-8"))
        if manifest.get("version") not in (5, 6) or manifest.get("family") != "anima":
            raise RunnerError("需要 Anima manifest v5")
        events = Events(manifest["paths"]["events_file"])
        (run_cache if args.phase == "cache" else run_train)(manifest, events)
    except Exception as error:
        if events is not None:
            events.emit("error", message=str(error))
        traceback.print_exc()
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
