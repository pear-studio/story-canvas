import { useEffect, useRef } from "react";
import { registerProjectSnapshotReader, type SnapshotReader } from "./project-snapshot-sync";

export function useProjectSnapshotReader(projectId: string, reader: SnapshotReader, scope = "") {
  const latest = useRef(reader);
  latest.current = reader;
  useEffect(() => registerProjectSnapshotReader(projectId, (read) => latest.current(read)), [projectId, scope]);
}
