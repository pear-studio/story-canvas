import * as factsImplementation from "./lora-training-facts.mjs";
import * as planImplementation from "./lora-training-plan.mjs";
import * as runtimeImplementation from "./lora-training-runtime.mjs";
import * as mediaImplementation from "./lora-training-media.mjs";
import { LoraTrainingError } from "./lora-training-support.mjs";

const facts = factsImplementation.createLoraTrainingFactsInterface(factsImplementation);
const plan = planImplementation.createLoraTrainingPlanInterface(planImplementation);
const runtime = runtimeImplementation.createLoraTrainingRuntimeInterface(runtimeImplementation);
const media = mediaImplementation.createLoraTrainingMediaInterface(mediaImplementation);

export function createLoraTrainingCoordination({ isActive, freeze, freezeResume, startManifest }) {
  let admission = false;
  return Object.freeze({
    startRun: async (projectRoot, projectDirectory, taskId, config, options = {}) => {
      if (admission || isActive()) throw new LoraTrainingError(409, "lora_training_active");
      admission = true;
      try {
        const snapshot = await freeze(projectRoot, projectDirectory, taskId, config, { runSettings: options.runSettings });
        const run = await startManifest(projectDirectory, snapshot.manifest, { projectId: options.projectId, mutateDerived: options.mutateDerived });
        return { run, manifest: snapshot.manifest };
      } finally {
        admission = false;
      }
    },
    resumeRun: async (projectRoot, projectDirectory, taskId, runId, config, request = {}, options = {}) => {
      if (admission || isActive()) throw new LoraTrainingError(409, "lora_training_active");
      admission = true;
      try {
        const snapshot = await freezeResume(projectRoot, projectDirectory, taskId, runId, config, request);
        const run = await startManifest(projectDirectory, snapshot.manifest, { projectId: options.projectId, mutateDerived: options.mutateDerived });
        return { run, manifest: snapshot.manifest };
      } finally {
        admission = false;
      }
    },
  });
}

const coordination = createLoraTrainingCoordination({
  isActive: runtimeImplementation.hasActiveLoraTraining,
  freeze: plan.freeze,
  freezeResume: plan.freezeResume,
  startManifest: runtime.startManifest,
});

/**
 * LoRA 顶层 Module。
 *
 * facts 负责项目事实及 Caption，plan 负责环境、方案和冻结快照，runtime
 * 只消费已验证的 frozen manifest，media 负责图片后处理。这个对象是
 * HTTP Adapter 唯一依赖的 Interface；各域的 Implementation 留在对应 Module。
 */
export const loraTrainingModule = Object.freeze({
  facts,
  plan,
  runtime,
  media,
  coordination,
  errors: Object.freeze({
    LoraTrainingError,
  }),
});

export { LoraTrainingError };
