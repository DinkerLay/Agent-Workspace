import {
  cloneTaskArchitectureSnapshotV3,
  type TaskArchitectureSnapshotV3,
} from "@agent-workspace/runtime-contracts";

export class InMemoryTaskArchitectureV3Repository {
  readonly #snapshots = new Map<string, TaskArchitectureSnapshotV3>();

  insert(snapshot: TaskArchitectureSnapshotV3): void {
    if (this.#snapshots.has(snapshot.architectureSnapshotId)) throw new Error("task_architecture_v3_duplicate");
    this.#snapshots.set(snapshot.architectureSnapshotId, cloneTaskArchitectureSnapshotV3(snapshot));
  }

  get(architectureSnapshotId: string): TaskArchitectureSnapshotV3 | undefined {
    const snapshot = this.#snapshots.get(architectureSnapshotId);
    return snapshot ? cloneTaskArchitectureSnapshotV3(snapshot) : undefined;
  }

  snapshot(): readonly TaskArchitectureSnapshotV3[] {
    return Object.freeze([...this.#snapshots.values()]
      .sort((left, right) => left.architectureSnapshotId.localeCompare(right.architectureSnapshotId))
      .map(cloneTaskArchitectureSnapshotV3));
  }
}
