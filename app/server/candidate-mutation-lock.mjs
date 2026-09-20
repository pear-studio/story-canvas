import { factStorage as storage } from "./story-facts.mjs";

// Browser selection is coordinated by the in-process project mutation coordinator.
// Agent CLI runs in another process, so both paths also take this filesystem lock.
// Ordering for delete is: candidate mutation -> page -> candidate media.
export function withCandidateMutationLock(projectRoot, projectId, operation) {
  return storage.withResourceLock(
    projectRoot,
    projectId,
    "candidate-selection-mutation",
    "candidate selection/delete",
    operation,
  );
}
