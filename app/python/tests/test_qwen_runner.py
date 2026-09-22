"""qwen-image21-lora-runner toy backend 验证（CPU，stdlib unittest）。

覆盖设计底稿 §6 与方案 §10 的无 GPU 检查项：累积 1/2/4、samples_seen、保存步数、
跨轮次采样确定性、连续 vs 保存/恢复一致性（toy 下位级一致）、stop 边界恢复点、故障注入拒绝恢复。
"""
import hashlib, importlib.util, json, pathlib, shutil, unittest

import torch

ROOT = pathlib.Path(__file__).resolve().parents[3]
RUNNER_PATH = ROOT / "app" / "python" / "qwen-image21-lora-runner.py"
spec = importlib.util.spec_from_file_location("qwen_runner", RUNNER_PATH)
runner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(runner)

TEST_ROOT = ROOT / "Saved" / "Tests" / "qwen-runner"
ITEM_IDS = ["item-d", "item-b", "item-a", "item-c"]  # 故意乱序，验证按 item_id 排序
WEIGHTS = {"item-a": 2, "item-b": 1, "item-c": 2, "item-d": 1}  # 展开长度 6


def sha256_bytes(data):
    return hashlib.sha256(data).hexdigest()


def build_manifest(root, *, steps=12, save_every=5, accum=1, seed=42, resume=None):
    root = pathlib.Path(root)
    inputs = root / "inputs"
    inputs.mkdir(parents=True, exist_ok=True)
    items = []
    for index, item_id in enumerate(ITEM_IDS):
        image = f"fake-image-bytes-{item_id}".encode()
        caption = f"caption of {item_id}, 中文标签"
        (inputs / f"{item_id}.png").write_bytes(image)
        (inputs / f"{item_id}.txt").write_text(caption, encoding="utf-8")
        items.append({"item_id": item_id, "asset_id": f"asset-{index}", "group_id": "g1",
                      "source_file": f"assets/{item_id}.png", "image_file": f"{item_id}.png",
                      "caption_file": f"{item_id}.txt",
                      "image_sha256": sha256_bytes(image), "caption_sha256": sha256_bytes(caption.encode("utf-8"))})
    return {
        "version": 5, "id": "run-test", "task_id": "task-test", "dataset_id": "ds-test",
        "created_at": "2026-01-01T00:00:00Z", "task_name": "t", "dataset_name": "d",
        "family": "qwen-image-2-1", "items": items, "groups": [], "models": [],
        "trainer": {"diffsynth_commit": "toy-commit", "python": "", "torch": "",
                    "runner": {"name": "qwen-image21-lora-runner", "version": 1, "sha256": ""}},
        "recipe": {"id": "qwen-image21-lora-v1", "version": 1, "sha256": "", "overrides": {}},
        "semantic_config": {
            "max_pixels": 1048576, "network_dim": 32, "learning_rate": 1e-4,
            "gradient_accumulation_steps": accum,
            "optimizer": {"type": "AdamW", "betas": [0.9, 0.999], "eps": 1e-8, "weight_decay": 0.01},
            "scheduler": {"type": "ConstantLR", "factor": 1 / 3, "total_iters": 5},
            "precision": {"base": "bf16", "lora": "bf16", "optimizer_state": "bf16"},
            "gradient_checkpointing": True, "network_alpha": 32,
            "lora_target_modules": ["transformer_blocks.0.attn.to_q"],
        },
        "run": {"max_train_steps": steps, "save_every_n_steps": save_every, "seed": seed, "note": ""},
        "sampling": {"weights": [{"item_id": i, "weight": w} for i, w in WEIGHTS.items()]},
        "resume": resume,
        "paths": {"inputs_dir": str(inputs), "cache_dir": str(root / "cache"),
                  "control_dir": str(root / "control"), "archive_dir": str(root),
                  "resume_dir": str(root / "resume"), "events_file": str(root / "events.jsonl"),
                  "log_file": str(root / "log.txt"), "checkpoints_dir": str(root / "checkpoints"),
                  "checkpoints_relative_path": "checkpoints"},
        "seed": seed,
    }


def read_events(manifest):
    path = pathlib.Path(manifest["paths"]["events_file"])
    return [json.loads(line) for line in path.read_text(encoding="utf-8").splitlines() if line.strip()]


def prepare(root, **kwargs):
    manifest = build_manifest(root, **kwargs)
    assert runner.run_cache(manifest, backend="toy") == "completed"
    return manifest


class RunnerTestCase(unittest.TestCase):
    def test_model_loader_only_receives_weight_shards(self):
        model_root = self.dir / 'models'
        model_root.mkdir(parents=True)
        entries = []
        for name in ['config.json', 'model.safetensors.index.json', 'model-00001.safetensors', 'model-00002.safetensors']:
            (model_root / name).write_bytes(b'{}')
            entries.append({'kind': 'text_encoder', 'relative_path': name, 'size_bytes': 2})
        actual = runner.QwenBackend._model_paths({'models': entries}, model_root, ['text_encoder'])
        self.assertEqual(actual, [[str(model_root / 'model-00001.safetensors'), str(model_root / 'model-00002.safetensors')]])

    def setUp(self):
        self.dir = TEST_ROOT / self.id().split(".")[-1]
        shutil.rmtree(self.dir, ignore_errors=True)
        self.dir.mkdir(parents=True)

    def tearDown(self):
        shutil.rmtree(self.dir, ignore_errors=True)

    def test_cache_deterministic_and_skip(self):
        manifest = build_manifest(self.dir)
        self.assertEqual(runner.run_cache(manifest, backend="toy"), "completed")
        record = json.loads((self.dir / "cache" / "cache-manifest.json").read_text(encoding="utf-8"))
        self.assertTrue(record["complete"])
        self.assertEqual(sorted(record["items"]), sorted(ITEM_IDS))
        for item_id in ITEM_IDS:
            self.assertTrue((self.dir / "cache" / f"{item_id}.pth").is_file())
        hashes = {i: record["items"][i]["sha256"] for i in ITEM_IDS}
        # 已完成且 hash 匹配的跳过
        skipped = []
        runner.run_cache(manifest, backend="toy", hooks={"cache_item": lambda item_id, s: skipped.append(s)})
        self.assertEqual(skipped, [True] * len(ITEM_IDS))
        # 删除一项后仅重建该项，且内容位级一致（缓存确定性）
        (self.dir / "cache" / "item-a.pth").unlink()
        skipped = []
        runner.run_cache(manifest, backend="toy", hooks={"cache_item": lambda item_id, s: skipped.append(s)})
        self.assertEqual(skipped.count(False), 1)
        record = json.loads((self.dir / "cache" / "cache-manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(record["items"]["item-a"]["sha256"], hashes["item-a"])
        # stop 控制文件：item 边界退出，不写完整标记
        shutil.rmtree(self.dir / "cache")
        (self.dir / "control").mkdir(exist_ok=True)
        (self.dir / "control" / "stop.json").write_text("{}", encoding="utf-8")
        self.assertEqual(runner.run_cache(manifest, backend="toy"), "stopped")
        record = json.loads((self.dir / "cache" / "cache-manifest.json").read_text(encoding="utf-8"))
        self.assertFalse(record["complete"])

    def test_accumulation_counts_and_loss_normalization(self):
        for accum in (1, 2, 4):
            with self.subTest(accum=accum):
                root = self.dir / f"accum-{accum}"
                manifest = prepare(root, steps=4, save_every=100, accum=accum)
                counts = {"opt": 0, "sch": 0}
                micros, snapshot, rng_states, sampled, grads = [], [None], [], [], [None]
                # 类级打补丁计数（实例包装会进入 scheduler.__dict__ 导致 state_dict 无法 pickle）
                orig_opt_step = torch.optim.AdamW.step
                orig_sch_step = torch.optim.lr_scheduler.ConstantLR.step

                def counted_opt(self_opt, *a, **k):
                    counts["opt"] += 1
                    return orig_opt_step(self_opt, *a, **k)

                def counted_sch(self_sch, *a, **k):
                    if counts.get("armed"):  # ConstantLR 构造时会自行 step 一次（torch 语义），不计入
                        counts["sch"] += 1
                    return orig_sch_step(self_sch, *a, **k)

                def before_step(optimizer, scheduler, model):
                    counts["armed"] = True
                    if grads[0] is None:
                        grads[0] = {n: p.grad.clone() for n, p in model.named_parameters()}

                hooks = {"update_begin": lambda model: snapshot.__setitem__(0, snapshot[0] or
                         {k: v.detach().clone() for k, v in model.state_dict().items()}),
                         "sample": sampled.append, "pre_forward": lambda: rng_states.append(torch.get_rng_state()),
                         "micro": lambda raw, scaled: micros.append((raw, scaled)), "before_step": before_step}
                torch.optim.AdamW.step = counted_opt
                torch.optim.lr_scheduler.ConstantLR.step = counted_sch
                try:
                    self.assertEqual(runner.run_train(manifest, backend="toy", hooks=hooks), "completed")
                finally:
                    torch.optim.AdamW.step = orig_opt_step
                    torch.optim.lr_scheduler.ConstantLR.step = orig_sch_step
                # optimizer/scheduler 调用次数 == 更新步数，与累积无关
                self.assertEqual((counts["opt"], counts["sch"]), (4, 4))
                # loss/G 归一化
                self.assertEqual(len(micros), 4 * accum)
                for raw, scaled in micros:
                    self.assertEqual(scaled, raw / accum)
                events = [e for e in read_events(manifest) if e["event"] == "optimizer_step"]
                self.assertEqual([e["step"] for e in events], [1, 2, 3, 4])
                self.assertEqual(events[-1]["samples_seen"], 4 * accum)
                for i, e in enumerate(events):
                    group = micros[i * accum:(i + 1) * accum]
                    self.assertEqual(e["loss"], sum(v for v, _ in group) / accum)
                # 重放验证累积梯度 == 各 microstep loss/G 梯度之和（CPU 位级一致）
                backend = runner.ToyBackend(manifest, "train")
                backend.model.load_state_dict(snapshot[0])
                for item_id, rng_state in zip(sampled[:accum], rng_states[:accum]):
                    torch.set_rng_state(rng_state)
                    data = torch.load(root / "cache" / f"{item_id}.pth", weights_only=False)
                    (backend.forward_loss(data) / accum).backward()
                for name, param in backend.model.named_parameters():
                    self.assertTrue(torch.equal(param.grad, grads[0][name]), name)

    def test_sampling_determinism_across_rounds(self):
        sequences, rounds = [], []
        for name in ("run-a", "run-b"):
            manifest = prepare(self.dir / name, steps=13, save_every=100, accum=1)
            sampled = []
            hooks = {"sample": sampled.append,
                     "after_update": lambda ctx: rounds.append(ctx["sampler"].round)}
            runner.run_train(manifest, backend="toy", hooks=hooks)
            sequences.append(sampled)
        self.assertEqual(sequences[0], sequences[1])  # 同 seed 两次运行序列一致
        self.assertEqual(len(sequences[0]), 13)
        self.assertGreaterEqual(max(rounds), 2)  # 覆盖跨轮次

    def test_save_boundaries(self):
        manifest = prepare(self.dir, steps=12, save_every=5)
        runner.run_train(manifest, backend="toy")
        saved = [5, 10, 12]  # 周期保存 + 正常结束最终保存
        for step in saved:
            self.assertTrue((self.dir / "checkpoints" / f"step-{step:06d}.safetensors").is_file())
            for name in ("lora.safetensors", "optimizer.pt", "scheduler.pt", "rng.pt", "sampler.json", "state.json"):
                self.assertTrue((self.dir / "resume" / f"step-{step:06d}" / name).is_file(), name)
        pointer = json.loads((self.dir / "resume" / "latest.json").read_text(encoding="utf-8"))
        self.assertEqual(pointer["snapshot_id"], "step-000012")
        state = json.loads((self.dir / "resume" / "step-000012" / "state.json").read_text(encoding="utf-8"))
        self.assertEqual((state["step"], state["samples_seen"]), (12, 12))
        events = read_events(manifest)
        self.assertEqual([e["step"] for e in events if e["event"] == "checkpoint"], saved)
        self.assertEqual([e["step"] for e in events if e["event"] == "resume_saved"], saved)
        self.assertEqual(events[-1]["event"], "end")
        self.assertEqual(events[-1]["status"], "completed")

    def test_resume_equivalence(self):
        # 连续 12 步 vs 5 步保存退出后恢复到 12：样本顺序/RNG/LR/loss/最终参数位级一致
        traces = []
        for name, legs in (("continuous", [12]), ("resumed", [5, 12])):
            root = self.dir / name
            manifest = prepare(root, steps=legs[0], save_every=5, accum=2)
            sampled, final_rng = [], [None]
            hooks = {"sample": sampled.append,
                     "after_update": lambda ctx: ctx["step"] == 12 and final_rng.__setitem__(0, torch.get_rng_state())}
            runner.run_train(manifest, backend="toy", hooks=hooks)
            if len(legs) == 2:
                state_file = root / "resume" / "step-000005" / "state.json"
                manifest["run"]["max_train_steps"] = 12
                manifest["resume"] = {"parent_run_id": "run-test", "source_snapshot_id": "step-000005",
                                      "source_sha256": sha256_bytes(state_file.read_bytes()), "start_step": 5}
                runner.run_train(manifest, backend="toy", hooks=hooks)
            steps = [e for e in read_events(manifest) if e["event"] == "optimizer_step"]
            params = {}
            from safetensors.torch import load_file
            for key, value in load_file(str(root / "checkpoints" / "step-000012.safetensors")).items():
                params[key] = value
            traces.append({"samples": sampled, "rng": final_rng[0],
                           "steps": [(e["step"], e["loss"], e["lr"], e["samples_seen"]) for e in steps],
                           "params": params})
        a, b = traces
        self.assertEqual(a["samples"], b["samples"])
        self.assertEqual(a["steps"], b["steps"])
        self.assertTrue(torch.equal(a["rng"], b["rng"]))
        self.assertEqual(sorted(a["params"]), sorted(b["params"]))
        for key in a["params"]:
            self.assertTrue(torch.equal(a["params"][key], b["params"][key]), key)
        # runner 永不删旧包
        self.assertTrue((self.dir / "resumed" / "resume" / "step-000005" / "state.json").is_file())
        pointer = json.loads((self.dir / "resumed" / "resume" / "latest.json").read_text(encoding="utf-8"))
        self.assertEqual(pointer["snapshot_id"], "step-000012")

    def test_stop_saves_complete_resume_point(self):
        manifest = prepare(self.dir, steps=12, save_every=5)
        control = pathlib.Path(manifest["paths"]["control_dir"])
        control.mkdir(parents=True, exist_ok=True)

        def stop_at_three(ctx):
            if ctx["step"] == 3:
                (control / "stop.json").write_text("{}", encoding="utf-8")

        self.assertEqual(runner.run_train(manifest, backend="toy", hooks={"after_update": stop_at_three}), "stopped")
        events = read_events(manifest)
        self.assertEqual(len([e for e in events if e["event"] == "optimizer_step"]), 3)
        self.assertEqual(events[-1]["status"], "stopped")
        self.assertTrue((self.dir / "checkpoints" / "step-000003.safetensors").is_file())
        pointer = json.loads((self.dir / "resume" / "latest.json").read_text(encoding="utf-8"))
        self.assertEqual(pointer["snapshot_id"], "step-000003")
        # 恢复点可用：续到 6 步正常完成
        state_file = self.dir / "resume" / "step-000003" / "state.json"
        (control / "stop.json").unlink()
        manifest["run"]["max_train_steps"] = 6
        manifest["resume"] = {"parent_run_id": "run-test", "source_snapshot_id": "step-000003",
                              "source_sha256": sha256_bytes(state_file.read_bytes()), "start_step": 3}
        self.assertEqual(runner.run_train(manifest, backend="toy"), "completed")

    def test_fault_injection_refuses_resume_and_keeps_packages(self):
        manifest = prepare(self.dir, steps=5, save_every=5)
        runner.run_train(manifest, backend="toy")
        snapshot = self.dir / "resume" / "step-000005"
        optimizer_bytes = (snapshot / "optimizer.pt").read_bytes()

        def resume_manifest(source_id="step-000005", source_sha=None):
            if source_sha is None:
                source_sha = sha256_bytes((snapshot / "state.json").read_bytes())
            manifest["resume"] = {"parent_run_id": "run-test", "source_snapshot_id": source_id,
                                  "source_sha256": source_sha, "start_step": 5}
            manifest["run"]["max_train_steps"] = 8
            return manifest

        # state.json 写坏：hash 不符，拒绝恢复
        state_bytes = (snapshot / "state.json").read_bytes()
        (snapshot / "state.json").write_text("corrupted", encoding="utf-8")
        with self.assertRaises(runner.RunnerError):
            runner.run_train(resume_manifest(source_sha=sha256_bytes(state_bytes)), backend="toy")
        (snapshot / "state.json").write_bytes(state_bytes)
        # 恢复包内文件被篡改：内部 hash 校验拒绝
        lora_file = snapshot / "lora.safetensors"
        lora_bytes = lora_file.read_bytes()
        lora_file.write_bytes(b"tampered" + lora_bytes[8:])
        with self.assertRaises(runner.RunnerError):
            runner.run_train(resume_manifest(), backend="toy")
        lora_file.write_bytes(lora_bytes)
        # latest.json / manifest 指向缺失快照：拒绝恢复
        (self.dir / "resume" / "latest.json").write_text(
            json.dumps({"snapshot_id": "step-000099", "step": 99, "state_sha256": "0" * 64}), encoding="utf-8")
        with self.assertRaises(runner.RunnerError):
            runner.run_train(resume_manifest(source_id="step-000099", source_sha="0" * 64), backend="toy")
        # 旧包完整保留
        self.assertEqual((snapshot / "optimizer.pt").read_bytes(), optimizer_bytes)
        self.assertEqual(sha256_bytes((snapshot / "state.json").read_bytes()), sha256_bytes(state_bytes))
        # 修复后同一快照仍可恢复
        (self.dir / "resume" / "latest.json").write_text(
            json.dumps({"snapshot_id": "step-000005", "step": 5, "state_sha256": sha256_bytes(state_bytes)}), encoding="utf-8")
        self.assertEqual(runner.run_train(resume_manifest(), backend="toy"), "completed")


if __name__ == "__main__":
    unittest.main()
