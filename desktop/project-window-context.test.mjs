import { describe, expect, it } from "vitest";
import { resolveProjectWindowContext, withProjectWindowContext } from "./project-window-context.cjs";

describe("desktop project window context", () => {
  it("injects the actual launch project into a dev-server URL", () => {
    const context = resolveProjectWindowContext({ projectPath: "/Users/dingyujie/CODES/Agent-WorkSpace" });
    const url = new URL(withProjectWindowContext("http://127.0.0.1:5189/", context));

    expect(url.searchParams.get("projectPath")).toBe("/Users/dingyujie/CODES/Agent-WorkSpace");
    expect(url.searchParams.get("projectName")).toBe("Agent-WorkSpace");
  });

  it("preserves an explicitly selected project", () => {
    const url = new URL(
      withProjectWindowContext(
        "http://127.0.0.1:5189/?projectPath=%2Ftmp%2Fother&projectName=Other",
        resolveProjectWindowContext({ projectPath: "/tmp/current" }),
      ),
    );

    expect(url.searchParams.get("projectPath")).toBe("/tmp/other");
    expect(url.searchParams.get("projectName")).toBe("Other");
  });
});
