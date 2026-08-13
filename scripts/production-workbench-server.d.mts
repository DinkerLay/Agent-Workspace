export function startProductionWorkbenchServer(input: Readonly<{
  repositoryRoot: string;
  host: "127.0.0.1";
  port: number;
  runtimeUrl: string;
  rendererToken: string;
  ownerId: string;
}>): Promise<Readonly<{
  url: string;
  close(): Promise<void>;
}>>;
