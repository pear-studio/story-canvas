export type LoraRunStatus = "starting" | "running" | "stopping" | "completed" | "failed" | "interrupted" | string;

export function loraRunControls(status: LoraRunStatus) {
  const active = status === "starting" || status === "running" || status === "stopping";
  return {
    showStop: status === "running",
    showDelete: !active,
  };
}
