import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID, createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import sharp from 'sharp';
import { ApiError } from './http-support.mjs';
import { readComparisonExperimentStorage, readComparisonExperimentView } from './comparison-experiment-storage.mjs';
import { readComparisonExperimentResult } from './comparison-experiment-runtime.mjs';

const invalid = message => { throw new ApiError(422, 'invalid_comparison_review', [message]); };
const publicStatus = status => status === 'incomplete' ? 'failed' : status;

// 与网页共用轻量投影；只有明确检查输入时才读取冻结执行计划。
export async function collectComparisonResults(projectDirectory, request) {
  if (!Array.isArray(request?.selections) || !request.selections.length) invalid('selections 不能为空');
  const rows = [], experiments = [], seen = new Set(), cache = new Map();
  for (const selection of request.selections) {
    if (typeof selection?.experiment_id !== 'string') invalid('必须指定 experiment_id');
    const id = selection.experiment_id;
    if (!cache.has(id)) cache.set(id, await (request.include_inputs
      ? readComparisonExperimentStorage(projectDirectory, id)
      : readComparisonExperimentView(projectDirectory, id)));
    const record = cache.get(id);
    if (!experiments.some(item => item.id === id)) experiments.push({ id, status: publicStatus(record.status.status), axes: record.manifest.axes });
    if (selection.cell_ids !== undefined && (!Array.isArray(selection.cell_ids) || !selection.cell_ids.length)) invalid('cell_ids 必须是非空数组');
    const filters = selection.axis_values ?? {};
    if (!filters || typeof filters !== 'object' || Array.isArray(filters)) invalid('axis_values 必须是对象');
    for (const [axis, value] of Object.entries(filters)) {
      if (!record.manifest.axes.some(item => item.type === axis && item.values.some(option => option.value_id === value))) invalid(`未知轴值 ${axis}: ${value}`);
    }
    const cells = selection.cell_ids === undefined ? record.manifest.cells : selection.cell_ids.map(cellId => {
      const cell = record.manifest.cells.find(item => item.id === cellId);
      if (!cell) invalid(`找不到 cell: ${cellId}`);
      return cell;
    });
    for (const cell of cells.filter(item => Object.entries(filters).every(([axis, value]) => item.axis_values[axis] === value))) {
      const key = `${id}/${cell.id}`;
      if (seen.has(key)) invalid(`重复选择 ${key}`);
      seen.add(key);
      const state = record.status.cells.find(item => item.id === cell.id);
      const input = record.execution?.cells.find(item => item.id === cell.id);
      const conditions = record.manifest.axes.map(axis => ({ axis: axis.type, ...axis.values.find(value => value.value_id === cell.axis_values[axis.type]) }));
      rows.push({ experiment_id: id, cell_id: cell.id, ordinal: cell.ordinal, axis_values: cell.axis_values,
        conditions, seed: cell.effective_seed, status: publicStatus(state.status), error: state.error ?? null,
        image: state.status === 'completed' ? { url: `/api/comparison-experiments/${encodeURIComponent(id)}/results/${cell.id}.png`, absolute_file: path.join(projectDirectory, "Saved", "comparison-results", id, 'results', cell.id, 'image.png'), sha256: state.result?.image?.sha256 ?? null } : null,
        ...(request.include_inputs ? { inputs: input ? { input_id: input.input_id, seed: input.seed, cfg: input.cfg,
          prompt: { positive: input.prompt.positive, negative: input.prompt.negative }, loras: input.loras,
          render_identity: record.preflight.inputs.find(spec => spec.id === input.input_id)?.render, workflow: input.workflow } : null } : {}) });
    }
  }
  return { experiments, counts: { total: rows.length, completed: rows.filter(row => row.status === 'completed').length,
    failed: rows.filter(row => row.status === 'failed').length }, rows };
}

// 精确报告实际变化，不猜测哪些变化是允许的，也不依赖特定 workflow 节点编号。
export function diffComparisonInputs(rows) {
  if (rows.length !== 2 || rows.some(row => !row.inputs)) invalid('差异检查需要恰好两个已有冻结执行输入的 cell');
  const differences = [];
  function visit(before, after, pointer) {
    if (isDeepStrictEqual(before, after)) return;
    if (before && after && typeof before === 'object' && typeof after === 'object' && !Array.isArray(before) && !Array.isArray(after)) {
      for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) visit(before[key], after[key], `${pointer}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`);
    } else differences.push({ path: pointer, before: before ?? null, after: after ?? null });
  }
  visit(rows[0].inputs, rows[1].inputs, '');
  return { cells: rows.map(({ experiment_id, cell_id }) => ({ experiment_id, cell_id })), identical: !differences.length, differences };
}

const escapeXml = value => String(value).replace(/[&<>"']/g, character => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[character]);
function sheetOptions(rows, { columns = 2, font_size = 32, title = '', labels } = {}) {
  if (!rows.length || rows.length > 36) invalid('每张拼图选择 1–36 个 cell，可分批导出');
  if (!Number.isInteger(columns) || columns < 1 || columns > 6) invalid('columns 必须为 1–6');
  if (!Number.isInteger(font_size) || font_size < 20 || font_size > 48) invalid('font_size 必须为 20–48');
  if (typeof title !== 'string') invalid('title 必须为文本');
  if (labels !== undefined && (!Array.isArray(labels) || labels.length !== rows.length || labels.some(label => typeof label !== 'string' || !label.trim()))) invalid('labels 必须与所选结果一一对应，且为非空文本');
  const experiments = [...new Set(rows.map(row => row.experiment_id))];
  const axisNames = { input: '测试输入', lora_config: 'LoRA', lora_weight: '权重', character_lora_weight: '角色权重', cfg: 'CFG' };
  return { columns, font_size, title: title.trim(), labels: rows.map((row, index) => {
    const caption = labels?.[index] ?? [
      ...(experiments.length > 1 ? [`实验 ${experiments.indexOf(row.experiment_id) + 1}`] : []),
      ...row.conditions.filter(item => item.axis !== 'seed').map(item => `${axisNames[item.axis] ?? item.axis}：${item.label}`),
      `Seed：${row.seed}`,
    ].join('\n');
    return `${index + 1}. ${caption.trim()}${row.status === 'completed' ? '' : `\n状态：${({ failed: '失败', pending: '待生成', running: '生成中', cancelled: '已取消' })[row.status] ?? row.status}`}`;
  }) };
}

export async function renderComparisonSheet(rows, options = {}, readImage) {
  const { columns, font_size, title, labels } = sheetOptions(rows, options);
  const width = 512, height = 748, padding = 16, layers = [];
  // Pango 按实际字体度量换行；不按字符数硬切中英文，也不缩小长标题的字号。
  const renderText = async (text, size, maxWidth) => sharp({ text: {
    text: escapeXml(text), font: `Microsoft YaHei ${size}`, width: maxWidth,
    rgba: true, dpi: 72, spacing: 8, wrap: 'word-char',
  } }).png().toBuffer({ resolveWithObject: true });
  const totalWidth = Math.min(columns, rows.length) * width;
  const heading = title ? await renderText(title, font_size + 6, totalWidth - padding * 2) : null;
  const headingHeight = heading ? heading.info.height + padding * 2 : 0;
  if (heading) layers.push({ input: heading.data, left: padding, top: padding });
  const captions = await Promise.all(labels.map(label => renderText(label, font_size, width - padding * 2)));
  const rowHeights = Array.from({ length: Math.ceil(rows.length / columns) }, (_, index) =>
    Math.max(...captions.slice(index * columns, (index + 1) * columns).map(caption => caption.info.height)) + padding * 2);
  let top = headingHeight;
  for (const [index, row] of rows.entries()) {
    const left = index % columns * width, labelHeight = rowHeights[Math.floor(index / columns)];
    layers.push({ input: captions[index].data, left: left + padding, top: top + padding });
    let bytes = null;
    if (row.image) {
      bytes = await readImage(row);
      if (row.image.sha256 && createHash('sha256').update(bytes).digest('hex') !== row.image.sha256) throw new ApiError(422, 'comparison_image_hash_mismatch', [row.cell_id]);
    }
    layers.push({ input: await (bytes ? sharp(bytes).resize(width, height, { fit: 'contain', background: '#eeeeee' })
      : sharp({ create: { width, height, channels: 3, background: '#eeeeee' } })).png().toBuffer(), left, top: top + labelHeight });
    if (index % columns === columns - 1 || index === rows.length - 1) top += labelHeight + height;
  }
  return sharp({ create: { width: totalWidth, height: top, channels: 3, background: 'white' } }).composite(layers).png().toBuffer();
}

export async function exportComparisonSheet(projectDirectory, review, options) {
  const sheet = sheetOptions(review.rows, options);
  const bytes = await renderComparisonSheet(review.rows, options, row => readComparisonExperimentResult(projectDirectory, row.experiment_id, row.cell_id));
  const directory = path.join(projectDirectory, "Saved", "comparison-reviews", randomUUID());
  await mkdir(directory, { recursive: true });
  const imagePath = path.join(directory, 'sheet.png'), indexPath = path.join(directory, 'index.json');
  await writeFile(imagePath, bytes);
  await writeFile(indexPath, JSON.stringify({ ...review, columns: sheet.columns, sheet, image_path: imagePath }, null, 2) + '\n');
  return { image_path: imagePath, index_path: indexPath, counts: review.counts };
}
