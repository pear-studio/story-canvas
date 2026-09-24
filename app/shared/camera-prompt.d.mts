export type CameraSettings = { direction: "front" | "side" | "back" | null; height: "above" | "below" | null; shot: string | null; view: "pov" | "female_pov" | "over_shoulder" | null; hands: boolean; legs: boolean; shadow: boolean; perspective: boolean; foreshortening: boolean; backgroundBlur: boolean; foregroundBlur: boolean };
export const CAMERA_DIRECTIONS: Readonly<Record<NonNullable<CameraSettings["direction"]>, string>>;
export const CAMERA_HEIGHTS: Readonly<Record<NonNullable<CameraSettings["height"]>, string>>;
export const CAMERA_SHOTS: Readonly<Record<string, string>>;
export const CAMERA_DEFAULTS: Readonly<CameraSettings>;
export function validateCameraSettings(settings: CameraSettings): CameraSettings;
export function parseCameraSettings(value: unknown): CameraSettings | null;
export function createCameraFragment(settings: CameraSettings): { description: string; camera_settings: CameraSettings };
export function cameraFragmentIndex(fragments: Array<{ camera_settings?: CameraSettings }>): number;

export const CAMERA_VIEWS: Readonly<Record<NonNullable<CameraSettings["view"]>, string>>;
export const CAMERA_BODY: Readonly<Record<"hands" | "legs" | "shadow", string>>;
export function changeCameraView(settings: CameraSettings, view: CameraSettings["view"]): CameraSettings;

export const CAMERA_EFFECTS: Readonly<Record<"perspective" | "foreshortening" | "backgroundBlur" | "foregroundBlur", {label: string; word: string}>>;
export function changeCameraPerspective(settings: CameraSettings, perspective: boolean): CameraSettings;
