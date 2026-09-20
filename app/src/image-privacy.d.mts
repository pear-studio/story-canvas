export const IMAGE_PRIVACY_STORAGE_KEY: string;

type ImagePrivacyStorage = Pick<Storage, "getItem" | "setItem">;
type ImagePrivacyRoot = Pick<HTMLElement, "dataset">;
type ImagePrivacyState = "visible" | "hidden" | "peek";

export function applyImagePrivacy(root: ImagePrivacyRoot, state: ImagePrivacyState): void;
export function initializeImagePrivacy(storage: ImagePrivacyStorage | null, root: ImagePrivacyRoot): boolean;
export function persistImagePrivacy(storage: ImagePrivacyStorage | null, root: ImagePrivacyRoot, hidden: boolean): void;
