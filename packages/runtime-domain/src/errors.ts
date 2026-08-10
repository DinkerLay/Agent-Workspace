export class DomainInvariantError extends Error {
  readonly code: string;

  constructor(code: string, message = code) {
    super(message === code ? code : `${code}: ${message}`);
    this.name = "DomainInvariantError";
    this.code = code;
  }
}

export function invariant(condition: unknown, code: string, message?: string): asserts condition {
  if (!condition) throw new DomainInvariantError(code, message);
}

export function assertExpectedRevision(actual: number, expected: number): void {
  invariant(Number.isSafeInteger(expected) && expected > 0, "expected_revision_invalid");
  invariant(actual === expected, "expected_revision_stale", `expected revision ${expected}, found ${actual}`);
}

export function assertNonEmptyText(value: string, code: string): void {
  invariant(typeof value === "string" && value.trim().length > 0, code);
}
