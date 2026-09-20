export function mediaVariantUrl(url: string, width: number): string {
  return `${url}${url.includes("?") ? "&" : "?"}w=${width}`;
}
