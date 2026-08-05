/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenCodeSessionPage } from "./opencodeWebUiPreview";

const { openPage, releasePage } = vi.hoisted(() => ({
  openPage: vi.fn(),
  releasePage: vi.fn(),
}));

vi.mock("../runtime/nativeBridge", () => ({
  openNativeAgentLoopOpenCodeSessionPage: openPage,
  releaseNativeAgentLoopOpenCodeSessionPage: releasePage,
}));

describe("OpenCodeSessionPage", () => {
  afterEach(() => {
    openPage.mockReset();
    releasePage.mockReset();
  });

  it("releases an achieved presentation lease and remounts the exact Session with a fresh lifecycle epoch", async () => {
    openPage
      .mockResolvedValueOnce({
        presentation: "direct_url",
        providerSessionId: "ses-conductor-original",
        presentationLeaseId: "lease-before-achieve",
        url: "http://127.0.0.1:4099/session/ses-conductor-original?epoch=1",
      })
      .mockResolvedValueOnce({
        presentation: "direct_url",
        providerSessionId: "ses-conductor-original",
        presentationLeaseId: "lease-after-resume",
        url: "http://127.0.0.1:4099/session/ses-conductor-original?epoch=2",
      });

    const view = render(
      <OpenCodeSessionPage
        runId="run-original"
        sessionId="task-1:run-original:conductor"
        sessionName="Conductor"
        presentationEpoch="4"
      />,
    );

    const firstFrame = await screen.findByTitle("Conductor OpenCode Web UI");
    expect(firstFrame.getAttribute("src")).toContain("epoch=1");

    // The same Task/Run/Provider Session returns to running, but the canonical
    // Task revision changes. That must close the old page lease before opening
    // a fresh presentation lease for the unchanged Session identity.
    view.rerender(
      <OpenCodeSessionPage
        runId="run-original"
        sessionId="task-1:run-original:conductor"
        sessionName="Conductor"
        presentationEpoch="6"
      />,
    );

    await waitFor(() => expect(releasePage).toHaveBeenCalledWith({
      runId: "run-original",
      sessionId: "task-1:run-original:conductor",
      leaseId: "lease-before-achieve",
    }));
    await waitFor(() => expect(openPage).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(screen.getByTitle("Conductor OpenCode Web UI").getAttribute("src")).toContain("epoch=2"));

    view.unmount();

    await waitFor(() => expect(releasePage).toHaveBeenCalledWith({
      runId: "run-original",
      sessionId: "task-1:run-original:conductor",
      leaseId: "lease-after-resume",
    }));
  });
});
