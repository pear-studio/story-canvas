// 数据集与训练方案分别保留读取版本，不使用项目版本或项目写队列。
export function createTrainingClient(request: typeof fetch = fetch) {
  const versions = new Map<string, string>();
  let pending: Promise<unknown> = Promise.resolve();
  const scope = (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return /\/lora-training\/(?:datasets|tasks)\/((?:dataset|lora)-[a-f0-9]{12})(?:\/|$)/.exec(url)?.[1] ?? "training";
  };
  const read = async (input: RequestInfo | URL, init?: RequestInit) => {
    const response = await request(input, init);
    const revision = response.headers.get("etag");
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    // 辅助信息（预检、运行参数等）不替换编辑器所读取的事实版本。
    const document = /\/lora-training\/(?:datasets|tasks)\/(?:dataset|lora)-[a-f0-9]{12}\/?(?:\?.*)?$/.test(url);
    if (response.ok && revision && document) versions.set(scope(input), revision);
    return response;
  };
  const write = (input: RequestInfo | URL, init?: RequestInit) => {
    const operation = pending.then(async () => {
      const headers = new Headers(init?.headers);
      const revision = versions.get(scope(input));
      if (revision) headers.set("if-match", revision);
      const response = await request(input, { ...init, headers });
      const next = response.headers.get("etag");
      if (response.ok && next) versions.set(scope(input), next);
      return response;
    });
    pending = operation.catch(() => undefined);
    return operation;
  };
  return { read, write };
}
