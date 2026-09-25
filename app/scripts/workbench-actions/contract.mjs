// 参数契约同时用于逐项帮助和执行校验。
export const string = description => ({ type: 'string', description });
export const object = description => ({ type: 'object', description });
export const schema = (properties = {}, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
export function invalid(message) { return Object.assign(new Error(message), { code: 'invalid_arguments' }); }
export function validate(parameters, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw invalid('args 必须是对象');
  for (const key of parameters.required) if (args[key] === undefined) throw invalid(`缺少参数 ${key}`);
  for (const [key, value] of Object.entries(args)) {
    const rule = parameters.properties[key];
    if (!rule) throw invalid(`未知参数 ${key}`);
    if (rule.type === 'array' ? !Array.isArray(value) : rule.type === 'object' ? !value || typeof value !== 'object' || Array.isArray(value)
      : rule.type === 'integer' ? !Number.isInteger(value) : typeof value !== rule.type) throw invalid(`${key} 必须是 ${rule.type}`);
    if (rule.type === 'string' && !value.trim() && !rule.allowEmpty) throw invalid(`${key} 不能为空`);
    if (rule.enum && !rule.enum.includes(value)) throw invalid(`${key} 可选值：${rule.enum.join(', ')}`);
    if ((rule.minimum !== undefined && value < rule.minimum) || (rule.maximum !== undefined && value > rule.maximum)) throw invalid(`${key} 超出允许范围`);
    if (rule.type === 'array') {
      if (rule.minItems !== undefined && value.length < rule.minItems || rule.maxItems !== undefined && value.length > rule.maxItems) throw invalid(`${key} 数量超出允许范围`);
      if (rule.items) for (const item of value) validate(schema({ item: rule.items }), { item });
    }
    if (rule.type === 'object' && rule.properties) validate(rule, value);
  }
}
export const array = (description, items = string('条目'), maxItems = 100) => ({ type: 'array', description, items, maxItems });
export const boolean = description => ({ type: 'boolean', description });
export const textValue = description => ({ type: 'string', allowEmpty: true, description });
export const pagination = {
  offset: { type: 'integer', description: '从0开始，默认0', minimum: 0 },
  limit: { type: 'integer', description: '默认20，最多50', minimum: 1, maximum: 50 },
};
export function paginate(items, { offset = 0, limit = 20 }) {
  return { total: items.length, offset, items: items.slice(offset, offset + limit), next_offset: offset + limit < items.length ? offset + limit : null };
}
