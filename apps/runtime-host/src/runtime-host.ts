import type {
  RuntimeCommand,
  RuntimeCommandResult,
  RuntimeEvent,
  RuntimeInvalidation,
  RuntimeReadModel,
  RuntimeReadRequest,
  MetaProfileOptionDefinition,
} from "@agent-workspace/runtime-contracts";
import {
  RuntimeApplication,
  createMetaProfileRegistry,
  createProviderRegistry,
  installBuiltInTemplates,
  type ProviderPort,
  type MetaAgentPort,
  createMetaAgentRegistry,
  type ManagedArtifactPort,
  type WorkspaceDirectoryResolver,
} from "@agent-workspace/runtime-application";
import { createRuntimeRepositories, SqliteRuntimeStore } from "@agent-workspace/runtime-store";
import { createNodeWorkspaceDirectoryResolver } from "./workspace-directory-resolver.js";
import { NodeManagedArtifactService } from "./managed-artifact-service.js";

export type RuntimeHostOptions = {
  readonly databasePath: string;
  readonly providerPorts?: readonly ProviderPort[];
  /** Configuration-only Provider ports; deliberately separate from Task ports. */
  readonly metaAgentPorts?: readonly MetaAgentPort[];
  /** Test seam; production uses the Host-owned Node resolver below. */
  readonly workspaceDirectoryResolver?: WorkspaceDirectoryResolver;
  /** Test seam; production uses the Host-owned managed Artifact service below. */
  readonly managedArtifactPort?: ManagedArtifactPort;
  /** Host-owned readiness definitions; IDs are the only values exposed to clients. */
  readonly metaProfileOptions?: readonly MetaProfileOptionDefinition[];
  readonly now?: () => string;
  readonly dispatchIntervalMs?: number;
  readonly onDiagnostic?: (event: { readonly code: string; readonly bindingId?: string; readonly error?: string }) => void;
};

export type RuntimeHost = {
  readonly application: RuntimeApplication;
  read(request?: RuntimeReadRequest): RuntimeReadModel;
  command(command: RuntimeCommand): Promise<RuntimeCommandResult>;
  subscribe(listener: (invalidation: RuntimeInvalidation) => void): () => void;
  reconcileProviderFact(fact: Parameters<RuntimeApplication["reconcileProviderFact"]>[0]): Promise<boolean>;
  drainOutbox(maxItems?: number): Promise<number>;
  startDispatcher(): () => void;
  /** Stops dispatch first, closes SQLite, then awaits adapter-owned resources. */
  close(): Promise<void>;
};

/**
 * Runtime Host is the only composition root that opens SQLite and receives
 * ProviderPort instances. No renderer, Electron preload, or browser transport
 * can obtain either of those capabilities.
 */
export function createRuntimeHost(options: RuntimeHostOptions): RuntimeHost {
  const store = new SqliteRuntimeStore({ path: options.databasePath, now: options.now });
  const repositories = createRuntimeRepositories(store);
  // Bootstrap before the application is exposed, so the first renderer read
  // deterministically includes the immutable starter Template.
  installBuiltInTemplates(repositories, store.now());
  const application = new RuntimeApplication({
    repositories,
    providers: createProviderRegistry(options.providerPorts ?? []),
    workspaceDirectoryResolver: options.workspaceDirectoryResolver ?? createNodeWorkspaceDirectoryResolver(),
    managedArtifactPort: options.managedArtifactPort ?? new NodeManagedArtifactService(),
    metaProfiles: createMetaProfileRegistry(options.metaProfileOptions ?? []),
    metaAgents: createMetaAgentRegistry(options.metaAgentPorts ?? []),
    now: options.now,
  });
  let closed = false;
  let closing: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let ticking = false;
  let providerReadinessRefreshing = false;
  let metaReadinessRefreshing = false;
  const observers = new Map<string, AbortController>();

  return {
    application,
    read: (request = {}) => application.read(request),
    async command(command) {
      ensureOpen(closed);
      return application.execute(command);
    },
    subscribe(listener) {
      ensureOpen(closed);
      return application.subscribe((event: RuntimeEvent) => {
        if (event.type === "runtime.invalidated") listener(event);
      });
    },
    reconcileProviderFact(fact) {
      ensureOpen(closed);
      return application.reconcileProviderFact(fact);
    },
    drainOutbox(maxItems) {
      ensureOpen(closed);
      return application.drainOutbox(maxItems);
    },
    startDispatcher() {
      ensureOpen(closed);
      if (timer) return () => stopDispatcher();
      const interval = Math.max(250, options.dispatchIntervalMs ?? 1_000);
      timer = setInterval(() => { void tick(); }, interval);
      void tick();
      return () => stopDispatcher();
    },
    close() {
      if (closing) return closing;
      if (closed) return Promise.resolve();
      stopDispatcher();
      closed = true;
      store.close();
      const ports: Array<ProviderPort | MetaAgentPort> = [
        ...new Set<ProviderPort | MetaAgentPort>([...(options.providerPorts ?? []), ...(options.metaAgentPorts ?? [])]),
      ];
      closing = Promise.allSettled(ports.map(async (port) => {
        if (!port.close) return;
        try {
          await port.close();
        } catch (error) {
          options.onDiagnostic?.({ code: "provider_close_failed", error: diagnostic(error) });
        }
      })).then(() => undefined);
      return closing;
    },
  };

  function stopDispatcher(): void {
    if (!timer) return;
    clearInterval(timer);
    timer = undefined;
    for (const controller of observers.values()) controller.abort();
    observers.clear();
  }

  async function tick(): Promise<void> {
    if (closed || ticking) return;
    ticking = true;
    try {
      // Durable recovery and effects always run before optional readiness
      // observation. A slow native capability probe must never hold this lane.
      await application.drainOutbox();
      for (const bindingId of application.observableBindingIds()) {
        if (!observers.has(bindingId)) startObservation(bindingId);
        try {
          await application.reconcileBinding(bindingId);
        } catch (error) {
          options.onDiagnostic?.({ code: "provider_reconcile_failed", bindingId, error: diagnostic(error) });
        }
      }
    } catch (error) {
      options.onDiagnostic?.({ code: "runtime_dispatch_failed", error: diagnostic(error) });
    } finally {
      ticking = false;
      refreshReadinessInBackground();
    }
  }

  function refreshReadinessInBackground(): void {
    if (closed) return;
    if (!providerReadinessRefreshing) {
      providerReadinessRefreshing = true;
      void Promise.resolve()
        .then(() => application.refreshProviderReadiness())
        .catch(() => options.onDiagnostic?.({ code: "provider_readiness_refresh_failed" }))
        .finally(() => { providerReadinessRefreshing = false; });
    }
    if (!metaReadinessRefreshing) {
      metaReadinessRefreshing = true;
      void Promise.resolve()
        .then(() => application.refreshMetaAgentReadiness())
        .catch(() => options.onDiagnostic?.({ code: "meta_readiness_refresh_failed" }))
        .finally(() => { metaReadinessRefreshing = false; });
    }
  }

  function startObservation(bindingId: string): void {
    const controller = new AbortController();
    observers.set(bindingId, controller);
    void application.observeBinding(bindingId, controller.signal)
      .catch((error) => options.onDiagnostic?.({ code: "provider_observation_failed", bindingId, error: diagnostic(error) }))
      .finally(() => observers.delete(bindingId));
  }
}

function ensureOpen(closed: boolean): void {
  if (closed) throw new Error("runtime_host_closed");
}

function diagnostic(error: unknown): string {
  return error instanceof Error ? error.message.slice(0, 500) : "runtime_error";
}
