export type PageMediaRequestToken = {
  identity: string;
  generation: number;
  signal: AbortSignal;
};

export function createPageMediaRequestGuard() {
  let generation = 0;
  let activeIdentity = "";
  let controller: AbortController | null = null;

  return {
    begin(identity: string): PageMediaRequestToken {
      controller?.abort();
      controller = new AbortController();
      activeIdentity = identity;
      generation += 1;
      return { identity, generation, signal: controller.signal };
    },
    isCurrent(token: PageMediaRequestToken) {
      return !token.signal.aborted
        && token.identity === activeIdentity
        && token.generation === generation;
    },
    cancel() {
      generation += 1;
      activeIdentity = "";
      controller?.abort();
      controller = null;
    },
  };
}
