import type {
  SessionIdAcpTaskExecutionGroupReadModel,
  SessionIdAcpTaskInboxDeliveryReadModel,
  SessionIdAcpTaskMessageReadModel,
  SessionIdAcpTaskRelayBlockReadModel,
} from "@agent-workspace/runtime-contracts";

/** Renderer aliases for the single validated ACP v3 Task projection. */
export type AgentLoopInboxDeliveryItem = SessionIdAcpTaskInboxDeliveryReadModel;
export type AgentLoopRelayBlockItem = SessionIdAcpTaskRelayBlockReadModel;
export type AgentLoopSessionMessageItem = SessionIdAcpTaskMessageReadModel;
export type AgentLoopExecutionGroup = SessionIdAcpTaskExecutionGroupReadModel;
