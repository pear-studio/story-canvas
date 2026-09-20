export type ProjectScopeToken = {
  projectId: string;
  projectGeneration: number;
};

export type ProjectLoadToken = ProjectScopeToken & {
  requestGeneration: number;
};

export function createProjectRequestGuard(initialProjectId = "") {
  let activeProjectId = initialProjectId;
  let projectGeneration = 0;
  let requestGeneration = 0;

  function scope(projectId = activeProjectId): ProjectScopeToken {
    return { projectId, projectGeneration };
  }

  return {
    activate(projectId: string) {
      if (projectId !== activeProjectId) {
        activeProjectId = projectId;
        projectGeneration += 1;
        requestGeneration += 1;
      }
      return scope();
    },
    scope,
    beginLoad(projectId = activeProjectId): ProjectLoadToken {
      requestGeneration += 1;
      return { ...scope(projectId), requestGeneration };
    },
    isProjectCurrent(token: ProjectScopeToken) {
      return token.projectId === activeProjectId && token.projectGeneration === projectGeneration;
    },
    isLoadCurrent(token: ProjectLoadToken) {
      return token.projectId === activeProjectId
        && token.projectGeneration === projectGeneration
        && token.requestGeneration === requestGeneration;
    },
  };
}
