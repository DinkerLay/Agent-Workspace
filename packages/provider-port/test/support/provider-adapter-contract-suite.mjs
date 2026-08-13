/**
 * Shared offline contract suite for every concrete Provider Adapter.
 *
 * `createFixture()` must return a fresh object with:
 * - adapter, transport, profile
 * - bindingRequest(extra?), inputRequest(extra?)
 * - nativeFact(scenario, extra?)
 *
 * The fixture transport is intentionally injected. These tests never contact a
 * real Provider, SDK, process, or credential source.
 */
import { providerFactDedupKey } from "../../src/index.mjs";

export function registerProviderAdapterContractSuite({ describe, it, assert, providerName, createFixture }) {
  describe(`${providerName} Provider Adapter contract`, () => {
    it("treats version observations as evidence while gating provider identity and capabilities", async () => {
      const fixture = createFixture();
      const available = await fixture.adapter.describeCapabilities(fixture.profile);
      assert.equal(available.available, true);
      assert.equal(available.provider, fixture.profile.provider);
      assert.equal(available.protocolFingerprint, fixture.profile.protocolFingerprint);

      const staleProfile = {
        ...fixture.profile,
        providerVersion: "profile-version-that-does-not-match-live-transport",
        protocolFingerprint: "sha256:wrong-schema",
      };
      const observed = await fixture.adapter.describeCapabilities(staleProfile);
      assert.equal(observed.available, true);
      assert.equal(observed.providerVersion, available.providerVersion);
      assert.equal(observed.protocolFingerprint, available.protocolFingerprint);
      assert.deepEqual(observed.unavailableReasons, []);
      await fixture.adapter.ensureBinding(fixture.bindingRequest({ executionProfile: staleProfile }));

      const wrongProviderProfile = {
        ...fixture.profile,
        provider: fixture.profile.provider === "codex" ? "opencode" : "codex",
      };
      const unavailable = await fixture.adapter.describeCapabilities(wrongProviderProfile);
      assert.equal(unavailable.available, false);
      assert.ok(unavailable.unavailableReasons.includes("execution_profile_provider_mismatch"));
      await assert.rejects(
        fixture.adapter.ensureBinding(fixture.bindingRequest({ executionProfile: wrongProviderProfile })),
        (error) => error?.code === "provider_unavailable",
      );

      const noCapabilities = createFixture({ capabilities: [] });
      const capabilityUnavailable = await noCapabilities.adapter.describeCapabilities(noCapabilities.profile);
      assert.equal(capabilityUnavailable.available, false);
      assert.ok(capabilityUnavailable.unavailableReasons.includes("capability_create_binding_unavailable"));
    });

    it("creates and resumes a binding through effects only", async () => {
      const fixture = createFixture();
      const created = await fixture.adapter.ensureBinding(fixture.bindingRequest({ disposition: "create" }));
      const resumed = await fixture.adapter.ensureBinding(fixture.bindingRequest({ disposition: "resume" }));

      assert.equal(created.kind, "ensure_binding");
      assert.equal(created.acceptance, "accepted");
      assert.equal(created.providerFactId, undefined, "effects must not masquerade as durable facts");
      assert.equal(resumed.acceptance, "accepted");
      assert.deepEqual(
        fixture.transport.calls.filter((call) => call.operation === "ensure_binding").map((call) => call.request.disposition),
        ["create", "resume"],
      );
    });

    it("keeps local delivery acceptance separate from native receipt and ambiguous receipt", async () => {
      const fixture = createFixture();
      const delivery = await fixture.adapter.submitDelivery(fixture.inputRequest());
      assert.equal(delivery.kind, "submit_delivery");
      assert.equal(delivery.acceptance, "accepted");
      assert.equal(delivery.providerFactId, undefined);

      fixture.transport.setReconciliation("binding-1", [
        fixture.nativeFact("receipt", { eventId: "receipt-1", messageId: "native-message-1" }),
        fixture.nativeFact("unprovenReceipt", { eventId: "receipt-2" }),
      ]);
      const facts = await fixture.adapter.reconcileBinding(fixture.bindingRequest());
      assert.deepEqual(facts.map((fact) => fact.kind), ["input_received", "transport_unknown"]);
      assert.equal(facts[0].correlation.nativeMessageId, "native-message-1");
      assert.equal(facts[1].payload.reason, "native_receipt_evidence_missing");
    });

    it("deduplicates repeated Provider events in both reconcile and observe paths", async () => {
      const fixture = createFixture();
      const duplicate = fixture.nativeFact("receipt", { eventId: "dedup-event", messageId: "native-message-dedup" });
      fixture.transport.setReconciliation("binding-1", [duplicate, { ...duplicate }]);
      fixture.transport.setStream("binding-1", [duplicate, { ...duplicate }]);

      const reconciled = await fixture.adapter.reconcileBinding(fixture.bindingRequest());
      const observed = [];
      for await (const fact of fixture.adapter.observeBinding(fixture.bindingRequest())) observed.push(fact);

      assert.equal(reconciled.length, 1);
      assert.equal(observed.length, 1);
      assert.equal(providerFactDedupKey(reconciled[0]), providerFactDedupKey(observed[0]));
      assert.match(providerFactDedupKey(reconciled[0]), /:event:/);
    });

    it("rejects conflicting Provider facts that reuse one durable event identity", async () => {
      const fixture = createFixture();
      const first = fixture.nativeFact("receipt", { eventId: "conflict-event", messageId: "native-message-first" });
      const conflicting = fixture.nativeFact("receipt", { eventId: "conflict-event", messageId: "native-message-other" });
      fixture.transport.setReconciliation("binding-1", [first, conflicting]);
      await assert.rejects(
        fixture.adapter.reconcileBinding(fixture.bindingRequest()),
        /provider_fact_dedup_conflict/,
      );

      fixture.transport.setStream("binding-1", [first, conflicting]);
      await assert.rejects(async () => {
        for await (const _fact of fixture.adapter.observeBinding(fixture.bindingRequest())) {
          // Consume the stream so the second, conflicting event is validated.
        }
      }, /provider_fact_dedup_conflict/);
    });

    it("rejects a stale attention reply before it reaches Provider transport", async () => {
      const fixture = createFixture();
      fixture.transport.setStream("binding-1", [fixture.nativeFact("attention", {
        eventId: "attention-event-1",
        attention: {
          attentionId: "attention-1",
          bindingId: "binding-1",
          bindingRevision: 1,
          nativeRequestId: "native-request-1",
          inputSubmissionId: "input-1",
        },
      })]);
      for await (const _fact of fixture.adapter.observeBinding(fixture.bindingRequest())) {
        // observation registers only provider-native attention scope; it does
        // not write an Attention record itself.
      }

      const stale = await fixture.adapter.respondAttention({
        ...fixture.bindingRequest(),
        attentionId: "attention-1",
        bindingRevision: 2,
        nativeRequestId: "native-request-1",
        activeInputSubmissionId: "input-1",
      });
      assert.equal(stale.kind, "respond_attention");
      assert.equal(stale.acceptance, "rejected");
      assert.equal(stale.diagnostic, "stale_attention");
      assert.equal(fixture.transport.calls.filter((call) => call.operation === "respond_attention").length, 0);

      const current = await fixture.adapter.respondAttention({
        ...fixture.bindingRequest(),
        attentionId: "attention-1",
        bindingRevision: 1,
        nativeRequestId: "native-request-1",
        activeInputSubmissionId: "input-1",
      });
      assert.equal(current.acceptance, "accepted");
      assert.equal(fixture.transport.calls.filter((call) => call.operation === "respond_attention").length, 1);
    });

    it("does not turn an interrupt effect into a confirmed cancellation", async () => {
      const fixture = createFixture();
      const interrupt = await fixture.adapter.requestInterrupt({
        ...fixture.bindingRequest(),
        idempotencyKey: "interrupt-1",
      });
      assert.equal(interrupt.kind, "request_interrupt");
      assert.equal(interrupt.acceptance, "accepted");

      fixture.transport.setReconciliation("binding-1", [fixture.nativeFact("interruptUnknown", {
        eventId: "interrupt-unknown-1",
        inputSubmissionId: "input-1",
      })]);
      const [fact] = await fixture.adapter.reconcileBinding(fixture.bindingRequest());
      assert.equal(fact.kind, "transport_unknown");
      assert.equal(fact.correlation.inputSubmissionId, "input-1");
      assert.notEqual(fact.kind, "interrupt_confirmed");
    });

    it("exposes background native children as facts without adopting a Workspace session", async () => {
      const fixture = createFixture();
      fixture.transport.setStream("binding-1", [fixture.nativeFact("backgroundChild", {
        eventId: "child-1",
        payload: { nativeChildId: "native-child-1", background: true },
      })]);
      const facts = [];
      for await (const fact of fixture.adapter.observeBinding(fixture.bindingRequest())) facts.push(fact);
      assert.equal(facts.length, 1);
      assert.equal(facts[0].kind, "native_child_observed");
      assert.equal(facts[0].payload.background, true);
      assert.equal(facts[0].logicalSessionId, undefined);
      assert.equal(facts[0].invocationAdopted, undefined);
    });
  });
}
