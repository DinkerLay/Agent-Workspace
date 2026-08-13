import type {
  SessionIdAcpCloseCompletionInput,
  SessionIdAcpCloseSessionOwnerCommand,
  SessionIdAcpCloseStageResult,
  createSessionIdAcpCloseSessionOwner,
} from "@agent-workspace/runtime-application";
import type {
  AcpTaskSessionRuntimeBindingRetirementResult,
  AcpTaskSessionRuntimeProvider,
} from "./acp-task-session-runtime-provider.js";

type CloseOwner = ReturnType<typeof createSessionIdAcpCloseSessionOwner>;

export type SessionIdAcpCloseSessionDrainOptions = Readonly<{
  owner: Pick<CloseOwner, "stageClose" | "completeClose">;
  provider: Pick<AcpTaskSessionRuntimeProvider, "retireBindingForClose">;
}>;

/**
 * Host-only close drain. Durable stage identities never cross the Conductor
 * tool result boundary; `closed` is returned only after Provider cleanup and
 * the generation/control completion transaction both commit.
 */
export function createSessionIdAcpCloseSessionDrain(options: SessionIdAcpCloseSessionDrainOptions) {
  if (!options
    || typeof options.owner?.stageClose !== "function"
    || typeof options.owner?.completeClose !== "function"
    || typeof options.provider?.retireBindingForClose !== "function") {
    throw new TypeError("session_close_drain_options_invalid");
  }
  return Object.freeze({ closeSession });

  async function closeSession(command: SessionIdAcpCloseSessionOwnerCommand) {
    const staged: SessionIdAcpCloseStageResult = options.owner.stageClose(command);
    if (staged.disposition !== "retirement_required") return staged.result;
    const retired: AcpTaskSessionRuntimeBindingRetirementResult =
      await options.provider.retireBindingForClose(staged.bindingRetirementIntentId);
    if (retired.disposition !== "released"
      || retired.bindingRetirementIntentId !== staged.bindingRetirementIntentId) {
      throw new Error("session_close_retirement_result_mismatch");
    }
    const completion: SessionIdAcpCloseCompletionInput = Object.freeze({
      command,
      bindingRetirementIntentId: staged.bindingRetirementIntentId,
    });
    const result = options.owner.completeClose(completion);
    if (!("status" in result) || result.status !== "closed") {
      throw new Error("session_close_completion_result_invalid");
    }
    return result;
  }
}
