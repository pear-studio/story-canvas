// 能力实现只有一份；限制插件按 Agent 添加约束，卸载后自动恢复。
const policies = new WeakMap();
export function restrictWorkbench(agent, capabilities) {
  const denied = new Set(capabilities);
  const entries = policies.get(agent) ?? new Set();
  entries.add(denied); policies.set(agent, entries);
  return () => { entries.delete(denied); if (!entries.size) policies.delete(agent); };
}
export function workbenchRestrictions(agent) {
  return new Set(agent ? [...(policies.get(agent) ?? [])].flatMap(entry => [...entry]) : []);
}
