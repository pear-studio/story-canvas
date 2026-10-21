export type VideoPostprocess = { trim_start_seconds: number; trim_end_seconds: number; speed: number };
export const defaultVideoPostprocess: Readonly<VideoPostprocess>;
export function normalizeVideoPostprocess(value?: unknown): VideoPostprocess;
export function hasVideoPostprocess(value?: unknown): boolean;
export function videoPostprocessTiming(video: {frames:number;fps:number}, value?: unknown): {start_frame:number;end_frame:number;frames:number;fps:number;duration_seconds:number};
