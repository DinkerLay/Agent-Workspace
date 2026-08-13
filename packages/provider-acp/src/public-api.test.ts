import { describe, expect, it } from "vitest";
import * as providerAcp from "./index.js";

describe("provider-acp public surface", () => {
  it("does not export private raw identity or fake wire fixtures", () => {
    expect(Object.keys(providerAcp).sort()).toEqual([
      "ACP_V1_PROTOCOL_MAJOR",
      "AcpBoundaryError",
      "createManagedAcpV1Client",
    ]);
    expect(providerAcp).not.toHaveProperty("GenerationPrivateIdentityMap");
    expect(providerAcp).not.toHaveProperty("FakeAcpV1Agent");
  });
});
