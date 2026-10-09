import { validateReferenceEntries } from '../../../shared/reference-images.mjs';
import { pagePromptAudit } from '../../prompt-audit.mjs';
import { resolveParticipantLoras } from '../../lora-config.mjs';

export function videoTiming(seconds) {
  if (!Number.isFinite(seconds) || seconds < 3 || seconds > 15) throw new TypeError('时长须为 3–15 秒');
  const frames = 17 * Math.round((seconds * 24 - 5) / 17) + 5;
  return { requested_seconds: seconds, frames, fps: 24, duration_seconds: frames / 24 };
}
export function emptyPrompt() { return { text: '', composition: 'standalone', reference_images: [], duration: 5, loop: false, quality: 'standard', steps: 20 }; }
export function validatePrompt(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return ['H3 输入必须是对象'];
  const errors = Object.keys(value).filter(k => !['$schema','text','composition','reference_images','duration','loop','quality','steps','loras'].includes(k)).map(k => `H3 未知字段：${k}`);
  if (typeof value.text !== 'string') errors.push('动作描述必须是字符串');
  if (value.composition !== 'standalone') errors.push('H3 采用独立输入');
  try { videoTiming(value.duration); } catch(e) { errors.push(e.message); }
  if (typeof value.loop !== 'boolean') errors.push('loop 必须是布尔值');
  if (!['preview','standard'].includes(value.quality)) errors.push('quality 必须为 preview 或 standard');
  if (!Number.isInteger(value.steps) || value.steps < 8 || value.steps > 50) errors.push('steps 须为 8–50');
  errors.push(...validateReferenceEntries(value.reference_images, { allowPurpose: true }));
  if ((value.reference_images?.length ?? 0) > 1) errors.push('H3 动态页只接收一张输入图');
  if (value.loras?.length) errors.push('首版 H3 不支持页面 LoRA');
  return errors;
}
export function compilePrompt({pageKey,pagePrompt,referencePlan,profile}) {
  const errors = validatePrompt(pagePrompt), missing = [];
  const profileLoras = resolveParticipantLoras(profile, []);
  errors.push(...profileLoras.errors);
  if (!pagePrompt.text?.trim()) missing.push('动作描述');
  if (referencePlan.sequence.length !== 1) missing.push('一张输入图');
  const timing = videoTiming(pagePrompt.duration);
  const alignment = `For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.`
    + (pagePrompt.loop ? ` At ${(timing.frames - 1) / 24} seconds into the target video, <Picture 2> (from [Shot 1]) is fully referenced.` : '');
  const positive = `${alignment}\n\nintegrated_multimodal_description: [Shot 1] 保持参考图的角色、服装、环境和画风。${pagePrompt.text}${pagePrompt.loop ? ' 动作平滑回到起始姿态与构图。' : ''}\noverall_soundscape: N/A\nnon_diegetic_music: N/A`;
  return {page_key:pageKey,ready:!errors.length&&!missing.length,errors,missing,positive_prompt:positive,negative_prompt:'',sections:[{kind:'page',text:pagePrompt.text}],images:referencePlan.sequence,audit:pagePromptAudit({missing,errors,positive}),loras:profileLoras.loras,video_settings:{...timing,loop:pagePrompt.loop,quality:pagePrompt.quality,steps:pagePrompt.steps}};
}
