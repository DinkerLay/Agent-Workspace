import { AcpReleaseParentPreflightBlockedError } from "./acp-release-parent-preflight.js";
import {
  AcpReleaseParentQualificationBlockedError,
  AcpReleaseParentQualificationCleanupError,
} from "./acp-release-parent-qualification.js";
import { runAcpReleaseParentProduction } from "./acp-release-parent-aggregate.js";
import { ReleaseCellBlockedError } from "./release-cell-runner.js";

try {
  const result = await runAcpReleaseParentProduction();
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  if (error instanceof AcpReleaseParentPreflightBlockedError
    || error instanceof AcpReleaseParentQualificationBlockedError
    || error instanceof ReleaseCellBlockedError) {
    process.stderr.write(`${JSON.stringify({
      outcome: "BLOCKED_CAPABILITY",
      reason: error instanceof ReleaseCellBlockedError
        ? "acp_release_required_cell_blocked"
        : error.code,
      ...(error instanceof AcpReleaseParentQualificationBlockedError && error.observation
        ? { qualification: error.observation }
        : {}),
    })}\n`);
    process.exitCode = 2;
  } else {
    process.stderr.write(`${JSON.stringify({
      outcome: "FAIL",
      code: safeParentFailureCode(error),
      ...(error instanceof AcpReleaseParentQualificationCleanupError && error.observation
        ? { qualificationCleanup: error.observation }
        : {}),
    })}\n`);
    process.exitCode = 1;
  }
}

function safeParentFailureCode(error: unknown): string {
  const candidate = error && typeof error === "object" && "code" in error
    ? (error as { readonly code?: unknown }).code
    : error instanceof Error
      ? error.message
      : undefined;
  return typeof candidate === "string"
    && /^(?:acp|journey)_release_[a-z0-9_]{1,112}$/u.test(candidate)
    ? candidate
    : "acp_release_parent_failed";
}
