import sharp from "sharp";
import { preparationDecision, preparationPolicy, trainingImageTarget } from "./lora-image-preparation-contract.mjs";

export async function prepareTrainingImage(cropped, { score, upscale, forceUpscale = false }) {
  const { width, height } = await sharp(cropped).metadata();
  const target = trainingImageTarget(width, height);
  // cover 和居中裁剪由工作台完成；训练器收到的已经是精确桶尺寸。
  const fit = buffer => sharp(buffer).resize({ ...target, fit: "cover", position: "centre", kernel: "lanczos3" }).png().toBuffer();
  const baseline = await fit(cropped);
  const before = await score(baseline);
  if (!Number.isFinite(before)) throw new Error("MUSIQ 未返回有效分数");
  let enhanced = null;
  let after = null;
  if (forceUpscale || before < preparationPolicy.skip_score) {
    // 大图先缩小；小图从源裁剪图超分，避免预先插值放大。
    const source = !forceUpscale && width >= target.width && height >= target.height ? baseline : cropped;
    enhanced = await fit(await upscale(source));
    after = await score(enhanced);
    if (!Number.isFinite(after)) throw new Error("MUSIQ 未返回有效分数");
  }
  const decision = forceUpscale ? "enhanced" : preparationDecision(before, after);
  return { baseline, enhanced, target, before_score: before, after_score: after, decision };
}
