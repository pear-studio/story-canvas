"""Anima 参数编译、冻结输入、上游 callback 与停止协议；不加载真实模型。"""
import argparse
import hashlib
import importlib.util
import inspect
import json
import os
import pathlib
import shutil
import sys
import types
import unittest
from unittest import mock

ROOT = pathlib.Path(__file__).resolve().parents[3]
SPEC = importlib.util.spec_from_file_location("anima_runner", ROOT / "app/python/anima-lora-runner.py")
runner = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runner)
TEST_ROOT = ROOT / "Saved/Tests/anima-runner"


def manifest(root, count=3):
    inputs, models = root / "inputs", root / "models"
    inputs.mkdir(parents=True)
    models.mkdir()
    items = []
    for index in range(count):
        item = {"item_id": f"item-{index}", "image_file": f"item-{index}.png", "caption_file": f"item-{index}.txt"}
        for kind, data in (("image", f"image {index}".encode()), ("caption", f"标签 {index}".encode())):
            (inputs / item[f"{kind}_file"]).write_bytes(data)
            item[f"{kind}_sha256"] = hashlib.sha256(data).hexdigest()
        items.append(item)
    entries = []
    for kind in ("dit", "text_encoder", "vae"):
        data = kind.encode()
        (models / f"{kind}.safetensors").write_bytes(data)
        entries.append({"kind": kind, "relative_path": f"{kind}.safetensors", "size_bytes": len(data), "sha256": hashlib.sha256(data).hexdigest()})
    return {"version": 5, "family": "anima", "items": items, "models": entries,
            "sampling": {"weights": [{"item_id": item["item_id"], "weight": 1 + index % 2} for index, item in enumerate(items)]},
            "trainer": {"root": str(root / "trainer"), "sd_scripts_commit": "test"},
            "semantic_config": {"max_pixels": 1048576, "micro_batch_size": 2, "gradient_accumulation_steps": 2,
                                "network_dim": 32, "network_alpha": 32, "learning_rate": 2e-5,
                                "optimizer": {"type": "AdamW8bit", "betas": [.9, .999], "eps": 1e-8, "weight_decay": .01},
                                "scheduler": {"type": "cosine", "warmup_ratio": .05},
                                "precision": {"base": "bf16", "lora": "bf16", "optimizer_state": "8bit"},
                                "gradient_checkpointing": True, "lora_target_modules": ["self_attn", "cross_attn", "mlp"],
                                "blocks_to_swap": 0, "timestep_sampling": "sigmoid", "sigmoid_scale": 1,
                                "loss_type": "l2", "weighting_scheme": "uniform"},
            "run": {"max_train_steps": 800, "save_every_n_steps": 100, "seed": 42}, "resume": None,
            "paths": {"inputs_dir": str(inputs), "cache_dir": str(root / "cache"), "models_root": str(models),
                      "archive_dir": str(root),
                      "control_dir": str(root / "control"), "events_file": str(root / "events.jsonl"),
                      "checkpoints_dir": str(root / "checkpoints")}}


class FakeLoss:
    def __init__(self, value):
        self.value = value

    def detach(self):
        return self

    def float(self):
        return self

    def item(self):
        return self.value


class FakeAccelerator:
    def __init__(self):
        self.ended = False

    def unwrap_model(self, model):
        return model

    def end_training(self):
        self.ended = True


class FakeTrainer:
    def post_process_network(self, *args):
        pass

    def on_step_start(self, *args, **kwargs):
        pass

    def process_batch(self, loss, **kwargs):
        return FakeLoss(loss)

    def _save_model(self, **kwargs):
        directory = pathlib.Path(kwargs["args"].output_dir)
        directory.mkdir(parents=True, exist_ok=True)
        (directory / kwargs["ckpt_name"]).write_bytes(f"weights-step-{kwargs['steps']}".encode())


class AnimaRunnerTests(unittest.TestCase):
    def setUp(self):
        self.root = TEST_ROOT / self.id().split(".")[-1]
        if self.root.exists():
            shutil.rmtree(self.root)
        self.root.mkdir(parents=True)
        self.manifest = manifest(self.root)

    def events(self):
        return [json.loads(line) for line in pathlib.Path(self.manifest["paths"]["events_file"]).read_text(encoding="utf-8").splitlines()]

    def test_dynamic_weighted_dataset_uses_hardlinks_and_frozen_captions(self):
        self.assertEqual(runner.run_cache(self.manifest), "completed")
        toml = runner.dataset_config_path(self.manifest).read_text(encoding="utf-8")
        self.assertIn("resolution = 1024", toml)
        self.assertIn("batch_size = 2", toml)
        self.assertIn("num_repeats = 2", toml)
        source = self.root / "inputs/item-1.txt"
        target = self.root / "cache/subsets/repeat-2/item-1.txt"
        self.assertTrue(source.samefile(target))
        self.assertEqual(source.read_text(encoding="utf-8"), "标签 1")
        self.assertFalse(any(event["event"] == "cache_progress" for event in self.events()))
        self.assertIn("latent/TE", self.events()[0]["detail"])

    def test_changed_frozen_caption_is_rejected(self):
        (self.root / "inputs/item-0.txt").write_text("changed", encoding="utf-8")
        with self.assertRaisesRegex(runner.RunnerError, "hash"):
            runner.prepare_dataset(self.manifest)

    def test_arguments_preserve_budget_and_target_modules(self):
        argv = runner.compile_arguments(self.manifest)
        self.assertEqual(argv[argv.index("--max_train_steps") + 1], "800")
        self.assertEqual(argv[argv.index("--lr_warmup_steps") + 1], "40")
        self.assertEqual(argv[argv.index("--blocks_to_swap") + 1], "0")
        self.assertEqual(argv[argv.index("--llm_adapter_lr") + 1], "0")
        self.assertIn("train_llm_adapter=false", argv)
        self.assertIn("--network_train_unet_only", argv)
        self.assertIn("--cache_text_encoder_outputs_to_disk", argv)
        self.assertNotIn("--save_state", argv)
        self.manifest["run"]["max_train_steps"] = 12
        self.manifest["semantic_config"]["micro_batch_size"] = 1
        self.manifest["semantic_config"]["gradient_accumulation_steps"] = 4
        argv = runner.compile_arguments(self.manifest)
        self.assertEqual(argv[argv.index("--max_train_steps") + 1], "12")
        self.assertEqual(argv[argv.index("--gradient_accumulation_steps") + 1], "4")

    def test_model_hash_is_rechecked(self):
        (self.root / "models/dit.safetensors").write_bytes(b"bad")
        with self.assertRaisesRegex(runner.RunnerError, "身份"):
            runner.compile_arguments(self.manifest)

    def test_optimizer_callback_deduplicates_epoch_callback(self):
        trainer = runner.trainer_class(FakeTrainer, self.manifest, runner.Events(self.manifest["paths"]["events_file"]))()
        accelerator, args = FakeAccelerator(), types.SimpleNamespace(output_dir=self.manifest["paths"]["checkpoints_dir"])
        trainer.post_process_network(args, accelerator, "network", [], None)
        trainer.process_batch(2)
        trainer.process_batch(4)
        trainer.sample_images(accelerator, args, None, 1)
        trainer.sample_images(accelerator, args, 1, 1)
        steps = [event for event in self.events() if event["event"] == "optimizer_step"]
        self.assertEqual(len(steps), 1)
        self.assertEqual(steps[0]["step"], 1)
        self.assertEqual(steps[0]["loss"], 3)

    def test_stop_at_update_boundary_saves_weights_without_resume(self):
        trainer = runner.trainer_class(FakeTrainer, self.manifest, runner.Events(self.manifest["paths"]["events_file"]))()
        accelerator, args = FakeAccelerator(), types.SimpleNamespace(output_dir=self.manifest["paths"]["checkpoints_dir"])
        trainer.post_process_network(args, accelerator, "network", [], None)
        control = pathlib.Path(self.manifest["paths"]["control_dir"])
        control.mkdir()
        (control / "stop.json").write_text("{}", encoding="utf-8")
        # 只在触发停止时需要 torch dtype；无需 CUDA。
        with self.assertRaises(runner.StopRequested):
            trainer.sample_images(accelerator, args, None, 3)
        checkpoints = [event for event in self.events() if event["event"] == "checkpoint"]
        self.assertEqual(checkpoints[0]["step"], 3)
        self.assertTrue(pathlib.Path(checkpoints[0]["file"]).is_file())
        self.assertFalse(any(event["event"] == "resume_saved" for event in self.events()))

    def test_stop_at_step_zero_does_not_publish_untrained_weights(self):
        trainer = runner.trainer_class(FakeTrainer, self.manifest, runner.Events(self.manifest["paths"]["events_file"]))()
        control = pathlib.Path(self.manifest["paths"]["control_dir"])
        control.mkdir()
        (control / "stop.json").write_text("{}", encoding="utf-8")
        with self.assertRaises(runner.StopRequested):
            trainer.sample_images(FakeAccelerator(), types.SimpleNamespace(), 0, 0)
        self.assertFalse(pathlib.Path(self.manifest["paths"]["events_file"]).exists())

    def test_checkpoint_is_atomic_and_same_step_is_not_overwritten(self):
        current_manifest = self.manifest
        observations = []

        class ObservedSave(FakeTrainer):
            def _save_model(self, **kwargs):
                output = pathlib.Path(current_manifest["paths"]["checkpoints_dir"])
                observations.append(list(output.glob("*.safetensors")))
                self.staging_uses_safetensors = kwargs["ckpt_name"].endswith(".safetensors")
                super()._save_model(**kwargs)
                observations.append(list(output.glob("*.safetensors")))

        trainer = runner.trainer_class(ObservedSave, self.manifest, runner.Events(self.manifest["paths"]["events_file"]))()
        args = types.SimpleNamespace(output_dir=self.manifest["paths"]["checkpoints_dir"])
        trainer._save_model(args=args, steps=5, ckpt_name="periodic.safetensors")
        original = self.root / "checkpoints/step-000005.safetensors"
        first_hash = runner.sha256_file(original)
        trainer._save_model(args=args, steps=5, ckpt_name="final.safetensors")
        self.assertEqual(observations, [[], []])
        self.assertTrue(trainer.staging_uses_safetensors)
        self.assertEqual(runner.sha256_file(original), first_hash)
        self.assertEqual(len(self.events()), 1)
        self.assertEqual(args.output_dir, self.manifest["paths"]["checkpoints_dir"])
        self.assertEqual(list((self.root / "checkpoints").iterdir()), [original])

    def test_resume_is_rejected(self):
        self.manifest["resume"] = {"start_step": 1}
        with self.assertRaisesRegex(runner.RunnerError, "续训"):
            runner.run_train(self.manifest)

    def test_preexisting_stop_skips_training(self):
        control = pathlib.Path(self.manifest["paths"]["control_dir"])
        control.mkdir()
        (control / "stop.json").write_text("{}", encoding="utf-8")
        self.assertEqual(runner.run_train(self.manifest), "stopped")
        self.assertEqual(self.events()[-1]["steps_completed"], 0)

    def test_full_runner_updates_saves_final_and_ends(self):
        current_manifest = self.manifest

        class FakeTrainLoop(FakeTrainer):
            def train(self, args):
                accelerator = FakeAccelerator()
                self.post_process_network(args, accelerator, "network", [], None)
                self.sample_images(accelerator, args, 0, 0)
                for step in range(1, 4):
                    self.on_step_start(args, accelerator, "network", [], None, {}, None)
                    self.process_batch(step)
                    self.sample_images(accelerator, args, None, step)
                self._save_model(args=args, ckpt_name="anima.safetensors", steps=3, epoch_no=1,
                                 accelerator=accelerator, save_dtype=None, unwrapped_nw="network")

        class FakeParser:
            def parse_args(self, argv):
                return types.SimpleNamespace(output_dir=current_manifest["paths"]["checkpoints_dir"])

        module = types.SimpleNamespace(AnimaNetworkTrainer=FakeTrainLoop, setup_parser=FakeParser)
        self.assertEqual(runner.run_train(self.manifest, trainer_module=module), "completed")
        events = self.events()
        self.assertEqual([event["step"] for event in events if event["event"] == "optimizer_step"], [1, 2, 3])
        self.assertEqual([event["step"] for event in events if event["event"] == "checkpoint"], [3])
        self.assertTrue((self.root / "checkpoints/step-000003.safetensors").is_file())
        self.assertEqual(events[-1]["event"], "end")
        self.assertEqual(events[-1]["steps_completed"], 3)

    def test_main_reports_failure_with_nonzero_exit(self):
        path = self.root / "manifest.json"
        path.write_text(json.dumps(self.manifest), encoding="utf-8")
        with mock.patch.object(runner, "run_train", side_effect=runner.RunnerError("test failure")), mock.patch.object(runner.traceback, "print_exc"):
            self.assertEqual(runner.main(["--manifest", str(path), "--phase", "train"]), 2)
        self.assertEqual(self.events()[-1]["event"], "error")
        self.assertEqual(self.events()[-1]["message"], "test failure")

    @unittest.skipUnless(os.environ.get("STORY_CANVAS_ANIMA_TRAINER_ROOT"), "未指定真实 trainer；普通 CPU 测试不依赖外部环境")
    def test_real_parser_and_callback_signatures(self):
        trainer_root = pathlib.Path(os.environ["STORY_CANVAS_ANIMA_TRAINER_ROOT"])
        sys.path.insert(0, str(trainer_root))
        import anima_train_network
        args = anima_train_network.setup_parser().parse_args(runner.compile_arguments(self.manifest))
        self.assertEqual(args.network_module, "networks.lora_anima")
        self.assertEqual(args.attn_mode, "torch")
        self.assertEqual(args.optimizer_type, "AdamW8bit")
        self.assertEqual(args.lr_warmup_steps, 40)
        self.assertEqual(args.llm_adapter_lr, 0)
        expected = {
            "post_process_network": ["self", "args", "accelerator", "network", "text_encoders", "unet"],
            "on_step_start": ["self", "args", "accelerator", "network", "text_encoders", "unet", "batch", "weight_dtype", "is_train"],
            "sample_images": ["self", "accelerator", "args", "epoch", "global_step", "device", "vae", "tokenizer", "text_encoder", "unet"],
            "_save_model": ["self", "args", "accelerator", "save_dtype", "ckpt_name", "unwrapped_nw", "steps", "epoch_no", "force_sync_upload"],
        }
        for name, parameters in expected.items():
            self.assertEqual(list(inspect.signature(getattr(anima_train_network.AnimaNetworkTrainer, name)).parameters), parameters)
        # 真实 network 实现验证 include/exclude 语义，仅构造几层 CPU Linear。
        import torch
        from networks import lora_anima

        class Block(torch.nn.Module):
            def __init__(self):
                super().__init__()
                for name in ["self_attn", "cross_attn", "mlp", "adaln_modulation_self_attn"]:
                    setattr(self, name, torch.nn.Sequential(torch.nn.Linear(4, 4)))

        dit = torch.nn.Module()
        dit.blocks = torch.nn.ModuleList([Block()])
        dit.llm_adapter = torch.nn.Linear(4, 4)
        network_args = dict(argument.split("=", 1) for argument in args.network_args)
        network = lora_anima.create_network(1, args.network_dim, args.network_alpha, None, [], dit, **network_args)
        self.assertEqual(len(network.unet_loras), 3)
        self.assertEqual(len(network.text_encoder_loras), 0)
        self.assertFalse(any("modulation" in lora.lora_name or "llm_adapter" in lora.lora_name for lora in network.unet_loras))


if __name__ == "__main__":
    unittest.main()
