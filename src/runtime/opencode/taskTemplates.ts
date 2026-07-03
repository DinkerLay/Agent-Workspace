import type { Agent, TaskIntakeSource, TaskSessionPlan, TaskSessionPlanSession } from "../../types";
import { safeSegment } from "./sessionKey";

export type OpencodeTaskTemplateId = "research" | "product-logic" | "spec-plan" | "implementation" | "debug-fix";

export type OpencodeTaskTemplateRole = Pick<Agent, "name" | "role" | "accent"> & {
  sessionPrompt: string;
};

export type OpencodeTaskTemplate = {
  id: OpencodeTaskTemplateId;
  label: string;
  intakeSource: TaskIntakeSource;
  roles: OpencodeTaskTemplateRole[];
  workerTargets: string[];
};

export const opencodeTaskTemplates: OpencodeTaskTemplate[] = [
  {
    id: "research",
    label: "调研任务",
    intakeSource: "manual-brief",
    roles: [
      {
        name: "Conductor",
        role: "Research coordinator",
        accent: "#111827",
        sessionPrompt:
          "You coordinate the research mainline as Conductor by assigning, reading, and routing provider-native worker sessions; do not write worker-owned research or review artifacts yourself.",
      },
      {
        name: "Researcher",
        role: "Evidence collector",
        accent: "#2563eb",
        sessionPrompt:
          "Collect evidence, cite durable sources, and write research artifacts when assigned in the terminal.",
      },
      {
        name: "Reviewer",
        role: "Source challenge",
        accent: "#be123c",
        sessionPrompt:
          "Challenge evidence quality, identify gaps, and write review notes when assigned in the terminal.",
      },
    ],
    workerTargets: ["Researcher", "Reviewer"],
  },
  {
    id: "product-logic",
    label: "产品逻辑任务",
    intakeSource: "manual-brief",
    roles: [
      {
        name: "Conductor",
        role: "Product coordinator",
        accent: "#111827",
        sessionPrompt:
          "You coordinate the product-logic mainline as Conductor by assigning, reading, and routing provider-native worker sessions; do not write worker-owned product artifacts yourself.",
      },
      {
        name: "Planner",
        role: "Interaction logic",
        accent: "#2563eb",
        sessionPrompt:
          "Map interaction logic, record product assumptions, and write product notes when assigned in the terminal.",
      },
      {
        name: "Reviewer",
        role: "Contradiction review",
        accent: "#be123c",
        sessionPrompt:
          "Challenge product contradictions and write review notes when assigned in the terminal.",
      },
    ],
    workerTargets: ["Planner", "Reviewer"],
  },
  {
    id: "spec-plan",
    label: "Spec-Plan 任务",
    intakeSource: "watcher",
    roles: [
      {
        name: "Conductor",
        role: "Spec coordinator",
        accent: "#111827",
        sessionPrompt:
          "You coordinate the spec-plan mainline as Conductor by assigning, reading, and routing provider-native worker sessions; do not write worker-owned spec or plan artifacts yourself.",
      },
      {
        name: "Planner",
        role: "Plan author",
        accent: "#2563eb",
        sessionPrompt:
          "Convert product facts into scoped specs or plans when assigned in the terminal.",
      },
      {
        name: "Reviewer",
        role: "Technical challenge",
        accent: "#be123c",
        sessionPrompt:
          "Challenge plan feasibility and write review notes when assigned in the terminal.",
      },
    ],
    workerTargets: ["Planner", "Reviewer"],
  },
  {
    id: "implementation",
    label: "代码实现任务",
    intakeSource: "prompt-context",
    roles: [
      {
        name: "Conductor",
        role: "Implementation coordinator",
        accent: "#111827",
        sessionPrompt:
          "You coordinate the implementation mainline as Conductor by assigning, reading, and routing provider-native worker sessions; do not write worker-owned code or verification artifacts yourself.",
      },
      {
        name: "Executor",
        role: "Code implementation",
        accent: "#0f766e",
        sessionPrompt:
          "Implement the scoped code change and preserve evidence when assigned in the terminal.",
      },
      {
        name: "QA",
        role: "Verification",
        accent: "#b45309",
        sessionPrompt:
          "Verify implementation behavior and write verification notes when assigned in the terminal.",
      },
    ],
    workerTargets: ["Executor", "QA"],
  },
  {
    id: "debug-fix",
    label: "Debug 修复任务",
    intakeSource: "screenshot-prototype",
    roles: [
      {
        name: "Conductor",
        role: "Debug coordinator",
        accent: "#111827",
        sessionPrompt:
          "You coordinate the debugging mainline as Conductor by assigning, reading, and routing provider-native worker sessions; do not write worker-owned fixes or verification artifacts yourself.",
      },
      {
        name: "Executor",
        role: "Fix implementation",
        accent: "#0f766e",
        sessionPrompt:
          "Reproduce the defect and implement the smallest fix when assigned in the terminal.",
      },
      {
        name: "QA",
        role: "Reproduction check",
        accent: "#b45309",
        sessionPrompt:
          "Verify reproduction and fix behavior when assigned in the terminal.",
      },
    ],
    workerTargets: ["Executor", "QA"],
  },
];

export function createDefaultTaskSessionPlanFromTemplate(input: {
  templateId: OpencodeTaskTemplateId | string;
  model: string;
  taskTitle?: string;
  taskGoal?: string;
}): TaskSessionPlan {
  const template = getOpencodeTaskTemplate(input.templateId);
  const conductorRole = template.roles.find((role) => role.name === "Conductor") ?? template.roles[0];
  const workerRoles = template.roles.filter((role) => role !== conductorRole);
  const taskGoal = input.taskGoal?.trim() || "等待填写任务目标。";

  return {
    templateId: template.id,
    defaultModel: input.model,
    conductor: {
      idSeed: "conductor",
      name: conductorRole.name,
      role: conductorRole.role,
      provider: "opencode",
      model: input.model,
      accent: conductorRole.accent,
      instructions: [
        conductorRole.sessionPrompt,
        "You are the task owner. Delegate worker-owned deliverables through call_session, read provider-extracted results, and keep the task mainline moving.",
      ].join(" "),
    },
    workers: workerRoles.map((role) => ({
      idSeed: role.name.toLowerCase(),
      name: role.name,
      role: role.role,
      provider: "opencode",
      model: input.model,
      accent: role.accent,
      instructions: role.sessionPrompt,
      expectedOutput: defaultExpectedOutputForTemplate(template.id, role.name, taskGoal),
    })),
    routePolicy: {
      allowedTargets: workerRoles.map((role) => role.name),
      notes: defaultRoutePolicyNotes(template.id),
    },
    workflow: defaultWorkflowForTemplate(template.id),
    deliverables: defaultDeliverablesForTemplate(template.id, taskGoal),
  };
}

export function normalizeTaskSessionPlan(
  value: unknown,
  fallback: TaskSessionPlan,
): TaskSessionPlan {
  if (!value || typeof value !== "object") return fallback;
  const payload = value as Partial<TaskSessionPlan>;
  const conductor = normalizePlanSession(payload.conductor, fallback.conductor) ?? fallback.conductor;
  const fallbackWorkers = fallback.workers.length ? fallback.workers : [];
  const workers = Array.isArray(payload.workers)
    ? payload.workers
        .map((worker, index) => normalizePlanSession(worker, fallbackWorkers[index] ?? fallbackWorkers[0]))
        .filter((worker): worker is TaskSessionPlanSession => Boolean(worker))
    : fallbackWorkers;

  return {
    templateId: stringOr(payload.templateId, fallback.templateId),
    defaultModel: stringOr(payload.defaultModel, fallback.defaultModel),
    conductor,
    workers: workers.length ? workers : fallbackWorkers,
    routePolicy: {
      allowedTargets: arrayOfStrings(payload.routePolicy?.allowedTargets).length
        ? arrayOfStrings(payload.routePolicy?.allowedTargets)
        : fallback.routePolicy?.allowedTargets,
      notes: arrayOfStrings(payload.routePolicy?.notes).length
        ? arrayOfStrings(payload.routePolicy?.notes)
        : fallback.routePolicy?.notes,
    },
    workflow: arrayOfStrings(payload.workflow).length ? arrayOfStrings(payload.workflow) : fallback.workflow,
    deliverables: arrayOfStrings(payload.deliverables).length
      ? arrayOfStrings(payload.deliverables)
      : fallback.deliverables,
    notes: arrayOfStrings(payload.notes).length ? arrayOfStrings(payload.notes) : fallback.notes,
  };
}

export function createTaskAgentsFromTemplate(input: {
  templateId: OpencodeTaskTemplateId;
  projectId: string;
  taskId: string;
  clusterId: string;
  model: string;
}): Agent[] {
  return createTaskAgentsFromSessionPlan({
    ...input,
    sessionPlan: createDefaultTaskSessionPlanFromTemplate({
      templateId: input.templateId,
      model: input.model,
    }),
  });
}

export function createTaskAgentsFromSessionPlan(input: {
  templateId: OpencodeTaskTemplateId | string;
  projectId: string;
  taskId: string;
  runtimeTaskId?: string;
  clusterId: string;
  model: string;
  sessionPlan?: TaskSessionPlan;
}): Agent[] {
  const fallback = createDefaultTaskSessionPlanFromTemplate({
    templateId: input.templateId,
    model: input.model,
  });
  const sessionPlan = normalizeTaskSessionPlan(input.sessionPlan, fallback);
  const sessions = [sessionPlan.conductor, ...sessionPlan.workers];
  const roleCounts = new Map<string, number>();

  return sessions.map((session) => {
    const baseRoleId = safeSegment((session.idSeed || session.name).toLowerCase());
    const count = roleCounts.get(baseRoleId) ?? 0;
    roleCounts.set(baseRoleId, count + 1);
    const roleId = count === 0 ? baseRoleId : `${baseRoleId}-${count + 1}`;

    return {
      id: `${input.taskId}-${roleId}`,
      projectId: input.projectId,
      runtimeTaskId: input.runtimeTaskId,
      clusterId: input.clusterId,
      taskId: input.taskId,
      name: session.name,
      role: session.role,
      provider: session.provider?.trim() || "opencode",
      model: session.model?.trim() || sessionPlan.defaultModel?.trim() || input.model,
      status: "idle",
      accent: session.accent?.trim() || "#64748b",
      lastActive: "not started",
    };
  });
}

export function getOpencodeTaskTemplate(templateId: OpencodeTaskTemplateId | string | undefined) {
  return opencodeTaskTemplates.find((item) => item.id === templateId) ?? opencodeTaskTemplates[0];
}

function normalizePlanSession(
  value: unknown,
  fallback: TaskSessionPlanSession | undefined,
): TaskSessionPlanSession | undefined {
  if (!value || typeof value !== "object") return fallback;
  const payload = value as Partial<TaskSessionPlanSession>;
  const name = stringOr(payload.name, fallback?.name);
  const role = stringOr(payload.role, fallback?.role);
  if (!name || !role) return fallback;

  return {
    idSeed: stringOr(payload.idSeed, fallback?.idSeed || safeSegment(name.toLowerCase())),
    name,
    role,
    provider: stringOr(payload.provider, fallback?.provider || "opencode"),
    model: stringOr(payload.model, fallback?.model),
    accent: stringOr(payload.accent, fallback?.accent),
    instructions: stringOr(payload.instructions, fallback?.instructions),
    expectedOutput: stringOr(payload.expectedOutput, fallback?.expectedOutput),
  };
}

function defaultExpectedOutputForTemplate(templateId: OpencodeTaskTemplateId, roleName: string, taskGoal: string) {
  if (templateId === "research" && roleName === "Researcher") {
    return `Research findings with durable sources for: ${taskGoal}`;
  }
  if (templateId === "research" && roleName === "Reviewer") {
    return "Source-quality review and challenge notes for the research output.";
  }
  if (templateId === "implementation") return "Code changes or verification notes, depending on role.";
  if (templateId === "debug-fix") return "Reproduction, fix evidence, or verification notes, depending on role.";
  if (templateId === "spec-plan") return "Spec, plan, or technical review notes, depending on role.";
  return "Role-owned notes and artifacts for the assigned task.";
}

function defaultRoutePolicyNotes(templateId: OpencodeTaskTemplateId) {
  if (templateId === "research") {
    return [
      "Dispatch evidence collection to Researcher.",
      "Dispatch source challenge to Reviewer after research output is available.",
      "If Reviewer requests changes, send the complete Review text back to the responsible worker, then dispatch Reviewer again for another pass.",
      "Only consolidate after Reviewer explicitly passes or says no further changes are needed.",
    ];
  }
  return [
    "Dispatch worker-owned work through call_session.",
    "Route review or verification feedback back to the responsible worker before final consolidation.",
  ];
}

function defaultWorkflowForTemplate(templateId: OpencodeTaskTemplateId) {
  if (templateId === "research") {
    return [
      "Conductor dispatches Researcher for evidence collection.",
      "Conductor reads Researcher result.",
      "Conductor dispatches Reviewer for source challenge.",
      "If review requests changes, Conductor dispatches the complete review text back to Researcher and then dispatches Reviewer again.",
      "Conductor performs final task-level consolidation only after review passes.",
    ];
  }
  return [
    "Conductor dispatches worker sessions for role-owned work.",
    "Conductor reads results and routes follow-up work to the responsible worker.",
    "Conductor performs final task-level consolidation after review or verification is satisfied.",
  ];
}

function defaultDeliverablesForTemplate(templateId: OpencodeTaskTemplateId, taskGoal: string) {
  if (templateId === "research") {
    return [
      "Research report under docs/research/.",
      "Spec clues under docs/superworks/spec/ when useful.",
      "Plan clues under docs/superworks/plans/ when useful.",
      `Goal coverage: ${taskGoal}`,
    ];
  }
  return [`Goal coverage: ${taskGoal}`];
}

function stringOr(value: unknown, fallback?: string) {
  return typeof value === "string" && value.trim() ? value.trim() : fallback;
}

function arrayOfStrings(value: unknown) {
  return Array.isArray(value)
    ? value.map((item) => (typeof item === "string" ? item.trim() : "")).filter(Boolean)
    : [];
}
