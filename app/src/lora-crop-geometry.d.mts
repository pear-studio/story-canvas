export type CropRect = { x: number; y: number; width: number; height: number };
export type CropHandle = "n" | "ne" | "e" | "se" | "s" | "sw" | "w" | "nw";
export type CropPoint = { x: number; y: number };
export type CropImageSize = { width: number; height: number };

export const MIN_CROP_SELECTION: number;
export function constrainCropRect(rect: CropRect): CropRect;
export function fitCropToAspect(rect: CropRect, pixelRatio: number, sourceSize: CropImageSize): CropRect;
export function resizeCropRect(rect: CropRect, handle: CropHandle, point: CropPoint, sourceSize: CropImageSize, lockAspect: boolean, pixelRatio: number): CropRect;
