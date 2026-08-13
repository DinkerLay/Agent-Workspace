export type ProductionReleaseExpectedDigests = Readonly<{
  sourceDigest: string;
  buildDigest: string;
  schemaDigest: string;
  providerPolicyDigest: string;
  policyDigest: string;
}>;
export type ProductionReleaseRunnerDigests = Readonly<{
  runnerSha256: string;
  workerSha256?: string;
}>;
export function productionReleaseIdentityInputBytes(
  repositoryRoot: string,
  runnerDigests: ProductionReleaseRunnerDigests,
): Promise<Readonly<{ source: Buffer; build: Buffer; schema: Buffer; providerPolicy: Buffer; policy: Buffer }>>;
export function productionReleaseNonBuildIdentityInputBytes(
  repositoryRoot: string,
  runnerDigests: ProductionReleaseRunnerDigests,
): Promise<Readonly<{ source: Buffer; schema: Buffer; providerPolicy: Buffer; policy: Buffer }>>;
export function assertProductionReleaseDigests(
  input: ProductionReleaseRunnerDigests & Readonly<{ repositoryRoot: string; expected: ProductionReleaseExpectedDigests }>,
): Promise<void>;
export function assertProductionReleaseNonBuildDigests(
  input: ProductionReleaseRunnerDigests & Readonly<{ repositoryRoot: string; expected: ProductionReleaseExpectedDigests }>,
): Promise<void>;
