// @vitest-environment jsdom
import { createElement } from "react";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { AgentLoopArtifactHtmlPreview } from "./AgentLoopArtifactHtmlPreview";

afterEach(() => {
  cleanup();
  delete (globalThis as Record<string, unknown>).__agentWorkspaceHtmlExecuted;
});

describe("AgentLoopArtifactHtmlPreview", () => {
  it("keeps untrusted HTML inside an empty sandbox with a restrictive leading CSP", () => {
    const html = '<h1>Report</h1><script>globalThis.__agentWorkspaceHtmlExecuted = true</script>';
    const { container } = render(createElement(AgentLoopArtifactHtmlPreview, { html, title: "report.html preview" }));

    const frame = screen.getByTitle("report.html preview");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    const srcDoc = frame.getAttribute("srcdoc") ?? "";
    expect(srcDoc).toMatch(/^<!doctype html><html><head><meta http-equiv="Content-Security-Policy"/i);
    expect(srcDoc).toContain("default-src 'none'");
    expect(srcDoc).toContain("script-src 'none'");
    expect(srcDoc).toContain("connect-src 'none'");
    expect(srcDoc).toContain("form-action 'none'");
    expect(srcDoc).toContain("base-uri 'none'");
    expect(srcDoc).toContain("frame-src 'none'");
    expect(srcDoc).toContain("style-src 'unsafe-inline'");
    expect(srcDoc).toContain("img-src data:");
    expect(container.querySelector("script")).toBeNull();
    expect((globalThis as Record<string, unknown>).__agentWorkspaceHtmlExecuted).toBeUndefined();
  });
});
