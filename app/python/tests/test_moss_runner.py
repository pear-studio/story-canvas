"""MOSS runner 的 CPU 隔离回归：冻结缓存、QKV 转换、累积边界停止和权重导出。"""
import copy
import importlib.util
import json
from pathlib import Path
import tempfile
import subprocess
import unittest

import torch
from safetensors.torch import load_file

ROOT = Path(__file__).resolve().parents[3]
ITEM_ID = "item-111111111111"
spec = importlib.util.spec_from_file_location("moss_runner", ROOT / "app/python/moss-image-lora-runner.py")
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)


class ToyModel(torch.nn.Module):
    def __init__(self):
        super().__init__()
        self.lora = torch.nn.Parameter(torch.tensor([1.0]))

    def export_trainable_state_dict(self, state, remove_prefix):
        assert remove_prefix == "pipe.dit."
        return {"layers.0.proj.q.lora_A.weight": state["lora"]}


class ToyBackend:
    def __init__(self, manifest, stop_after_micro=None):
        self.manifest = manifest
        self.stages = []
        self.micro = 0
        self.stop_after_micro = stop_after_micro

    def begin_cache(self, stage):
        self.stages.append(stage)

    def encode(self, stage, image, caption):
        if stage == "vae":
            return {"input_latents": torch.ones(1, 128, 2, 2)}
        return {"prompt_embeds": torch.ones(1, 2, 4096), "prompt_embeds_mask": torch.ones(1, 2, dtype=torch.bool)}

    def end_cache(self):
        self.stages.append("released")

    def build_model(self):
        return ToyModel()

    def loss(self, model, tensors):
        self.micro += 1
        if self.micro == self.stop_after_micro:
            runner.atomic_json(Path(self.manifest["paths"]["control_dir"]) / "stop.json", {"stop": True})
        return model.lora.square().sum()


class MossRunnerTests(unittest.TestCase):
    def setUp(self):
        parent = ROOT / "Saved/Tests/moss-runner"
        parent.mkdir(parents=True, exist_ok=True)
        self.temporary = tempfile.TemporaryDirectory(dir=parent)
        root = Path(self.temporary.name)
        inputs = root / "inputs"
        inputs.mkdir()
        (inputs / "image.png").write_bytes(b"frozen-image")
        (inputs / "caption.txt").write_text("Frozen Caption 原文。", encoding="utf-8")
        sc = json.loads((ROOT / "library/lora-training/recipes/moss-image-sft-lora-v1.json").read_text(encoding="utf-8"))["semantic_config"]
        sc["gradient_accumulation_steps"] = 3
        self.manifest = {
            "version": 6, "family": "moss-image", "semantic_config": sc,
            "id": "run-111111111111", "task_id": "dataset-111111111111", "dataset_id": "dataset-111111111111",
            "caption_set_id": "caption-set-111111111111", "created_at": "2026-10-27T00:00:00Z",
            "task_name": "CPU 隔离测试", "dataset_name": "合成测试数据", "description": "", "activation_terms": [],
            "prompt_family": "moss", "usage_defaults": {"clip_skip": None, "sampler": "euler", "scheduler": "simple", "steps": 30, "cfg": 3},
            "groups": [{"id": "group-111111111111", "name": "测试", "enabled": True, "repeats": 2}], "resume": None,
            "trainer": {"root": str(root), "diffsynth_commit": "f" * 40, "python": "3.11.0", "torch": torch.__version__, "gpu": None, "vram_bytes": 0,
                        "runner": {"name": runner.RUNNER_NAME, "version": runner.RUNNER_VERSION, "sha256": runner.sha256(ROOT / "app/python/moss-image-lora-runner.py")}},
            "recipe": {"id": "moss-image-sft-lora-v1", "version": 1, "sha256": "f" * 64, "overrides": {}},
            "run": {"max_train_steps": 3, "save_every_n_steps": 2, "seed": 42}, "seed": 42,
            "models": [{"kind": kind, "relative_path": f"{kind}/model.safetensors", "sha256": "f" * 64, "size_bytes": 1, "source": None}
                       for kind in ("dit", "text_encoder", "vae", "tokenizer")],
            "sampling": {"weights": [{"item_id": ITEM_ID, "weight": 2}]},
            "paths": {"inputs_dir": str(inputs), "cache_dir": str(root / "cache"), "control_dir": str(root / "control"),
                      "events_file": str(root / "events.jsonl"), "checkpoints_dir": str(root / "checkpoints"), "archive_dir": str(root), "resume_dir": str(root / "resume"),
                      "models_root": str(root / "models"), "log_file": str(root / "log.txt"), "checkpoints_relative_path": "checkpoints"},
            "execution": {"executable": "python.exe", "argv": [str(ROOT / "app/python/moss-image-lora-runner.py")]},
            "items": [{"item_id": ITEM_ID, "asset_id": "asset-111111111111", "group_id": "group-111111111111", "source_file": "source.png", "image_file": "image.png", "caption_file": "caption.txt",
                       "image_sha256": runner.sha256(inputs / "image.png"), "caption_sha256": runner.sha256(inputs / "caption.txt")}],
        }

    def tearDown(self):
        self.temporary.cleanup()

    def prepare(self):
        backend = ToyBackend(self.manifest)
        self.assertEqual(runner.run_cache(self.manifest, backend=backend), "completed")
        self.assertEqual(backend.stages, ["vae", "released", "text", "released"])
        return backend

    def events(self):
        return [json.loads(line) for line in Path(self.manifest["paths"]["events_file"]).read_text(encoding="utf-8").splitlines()]

    def test_qkv_split_exact_order_and_reject_invalid_shape(self):
        fused = torch.arange(27).reshape(9, 3)
        state = runner.split_fused_qkv({"layers.0.proj.qkv.weight": fused, "rope.bands": torch.ones(1)})
        self.assertTrue(torch.equal(state["layers.0.proj.q.weight"], fused[:3]))
        self.assertTrue(torch.equal(state["layers.0.proj.k.weight"], fused[3:6]))
        self.assertTrue(torch.equal(state["layers.0.proj.v.weight"], fused[6:]))
        self.assertNotIn("layers.0.proj.qkv.weight", state)
        with self.assertRaises(runner.RunnerError):
            runner.split_fused_qkv({"layers.0.proj.qkv.weight": torch.zeros(8, 3)})

    def test_fixture_matches_workbench_manifest_contract(self):
        source = ("import {validateLoraTrainingRunManifest as validate} from "
                  + json.dumps((ROOT / "app/server/lora-training-run-manifest.mjs").as_uri())
                  + ";let input='';for await(const chunk of process.stdin) input+=chunk;"
                    "const errors=validate(JSON.parse(input));if(errors.length){console.error(errors);process.exit(1);}")
        subprocess.run(["node", "--input-type=module", "-e", source], input=json.dumps(self.manifest), text=True, capture_output=True, check=True)

    def test_cache_integrity_and_caption_identity(self):
        self.prepare()
        files = runner.validate_cache(self.manifest)
        files[ITEM_ID].write_bytes(b"corrupt")
        with self.assertRaisesRegex(runner.RunnerError, "缓存 hash"):
            runner.validate_cache(self.manifest)
        self.prepare()
        (Path(self.manifest["paths"]["inputs_dir"]) / "caption.txt").write_text("changed", encoding="utf-8")
        with self.assertRaisesRegex(runner.RunnerError, "Caption hash"):
            runner.validate_cache(self.manifest)

    def test_train_accumulation_checkpoint_prefix_and_no_resume_package(self):
        backend = self.prepare()
        self.assertEqual(runner.run_train(self.manifest, backend=backend), "completed")
        updates = [event for event in self.events() if event["event"] == "optimizer_step"]
        self.assertEqual([event["samples_seen"] for event in updates], [3, 6, 9])
        saves = [event for event in self.events() if event["event"] == "checkpoint"]
        self.assertEqual([event["step"] for event in saves], [2, 3])
        for event in saves:
            self.assertEqual(runner.sha256(event["file"]), event["sha256"])
            self.assertTrue(all(key.startswith("diffusion_model.") for key in load_file(event["file"])))
        self.assertEqual(backend.micro, 9)
        self.assertFalse(list(Path(self.temporary.name).rglob("optimizer.pt")))

    def test_stop_completes_accumulation_and_saves_once(self):
        self.prepare()
        backend = ToyBackend(self.manifest, stop_after_micro=1)
        self.assertEqual(runner.run_train(self.manifest, backend=backend), "stopped")
        self.assertEqual(backend.micro, 3)
        saves = [event for event in self.events() if event["event"] == "checkpoint"]
        self.assertEqual([event["step"] for event in saves], [1])
        self.assertEqual(self.events()[-1]["samples_seen"], 3)

    def test_weighted_sampler_and_manifest_rejection(self):
        weights = [{"item_id": "a", "weight": 3}, {"item_id": "b", "weight": 1}]
        a, b = runner.WeightedSampler(weights, 37), runner.WeightedSampler(weights, 37)
        cycle = [a.next() for _ in range(4)]
        self.assertEqual(cycle.count("a"), 3)
        self.assertEqual(cycle, [b.next() for _ in range(4)])
        for patch in ({"family": "anima"}, {"version": 5}, {"resume": {"step": 1}}):
            manifest = {**copy.deepcopy(self.manifest), **patch}
            with self.assertRaises(runner.RunnerError):
                runner.validate_manifest(manifest)

    def test_cache_stage_stop_never_marks_complete(self):
        runner.atomic_json(Path(self.manifest["paths"]["control_dir"]) / "stop.json", {})
        backend = ToyBackend(self.manifest)
        self.assertEqual(runner.run_cache(self.manifest, backend=backend), "stopped")
        self.assertEqual(backend.stages, [])
        with self.assertRaisesRegex(runner.RunnerError, "缓存未完成"):
            runner.validate_cache(self.manifest)


if __name__ == "__main__":
    unittest.main()
