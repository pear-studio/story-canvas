import { responseJson } from "./api-response";
import { PROJECT_REVISION_HEADER, readFacts } from "./project-write-client";

export type SnapshotRead = <T>(url: string) => Promise<T>;
export type SnapshotReader = (read: SnapshotRead) => Promise<() => void>;
const readers = new Map<string, Set<SnapshotReader>>();

export function registerProjectSnapshotReader(projectId: string, reader: SnapshotReader) {
  const group = readers.get(projectId) ?? new Set<SnapshotReader>();
  group.add(reader); readers.set(projectId, group);
  return () => { group.delete(reader); if (!group.size) readers.delete(projectId); };
}

// 独立事实页先准备同版本数据，根组件通过竞态检查后统一应用，再推进写入版本。
export async function prepareProjectSnapshotReaders(projectId: string, revision: string, signal?: AbortSignal) {
  const group = [...(readers.get(projectId) ?? [])];
  const read: SnapshotRead = async <T>(url: string) => {
    const response = await readFacts(url, { signal, cache: "no-store" });
    const data = await responseJson<T>(response);
    if (response.headers.get(PROJECT_REVISION_HEADER) !== revision) throw new Error("项目在同步期间发生变化");
    return data;
  };
  const apply = await Promise.all(group.map((reader) => reader(read)));
  return () => {
    const current = readers.get(projectId) ?? new Set();
    if (current.size !== group.length || group.some((reader) => !current.has(reader))) throw new Error("活动事实页已切换，稍后重新同步");
    apply.forEach((commit) => commit());
  };
}
