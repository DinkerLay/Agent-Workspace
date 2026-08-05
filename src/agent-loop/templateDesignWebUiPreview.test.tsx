/**
 * @vitest-environment jsdom
 */
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TemplateDesignWebUiPreview } from "./templateDesignWebUiPreview";

const { openPage, releasePage } = vi.hoisted(() => ({
  openPage: vi.fn(),
  releasePage: vi.fn(),
}));

vi.mock("../runtime/nativeBridge", () => ({
  openNativeAgentLoopTemplateDesignSessionPage: openPage,
  releaseNativeAgentLoopTemplateDesignSessionPage: releasePage,
}));

describe("TemplateDesignWebUiPreview", () => {
  afterEach(() => {
    openPage.mockReset();
    releasePage.mockReset();
  });

  it("renders only the Host-resolved official page and releases its presentation lease on hide", async () => {
    openPage.mockResolvedValue({
      presentation: "direct_url",
      providerSessionId: "ses-template-design",
      presentationLeaseId: "lease-template-design",
      url: "http://127.0.0.1:4099/session/ses-template-design",
    });

    const view = render(<TemplateDesignWebUiPreview draftId="draft-1" templateName="DeepSearch" />);

    const frame = await screen.findByTitle("DeepSearch Template Meta Agent OpenCode Web UI");
    expect(frame.getAttribute("src")).toBe("http://127.0.0.1:4099/session/ses-template-design");
    expect(openPage).toHaveBeenCalledWith({ draftId: "draft-1" });

    view.unmount();

    await waitFor(() => expect(releasePage).toHaveBeenCalledWith({
      draftId: "draft-1",
      leaseId: "lease-template-design",
    }));
  });
});
