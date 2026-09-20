export type PageKey = { page_id: string };

export function pageKeyId(pageKey: PageKey) { return `v3/${pageKey.page_id}`; }
export function samePageKey(left: PageKey | null | undefined, right: PageKey | null | undefined) {
  return Boolean(left && right && left.page_id === right.page_id);
}
