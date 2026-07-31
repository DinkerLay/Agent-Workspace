/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { TaskConversationComposer } from "./TaskConversationComposer";

function DraftHost() {
  const [visible, setVisible] = useState(true);
  const [draft, setDraft] = useState("");
  return <>
    <button onClick={() => setVisible((current) => !current)}>切换页面</button>
    {visible ? <TaskConversationComposer disabled={false} message={draft} onMessageChange={setDraft} onSubmit={async () => undefined} onStop={() => undefined} /> : null}
  </>;
}

describe("TaskConversationComposer", () => {
  it("keeps the caller-owned Task draft when the page temporarily unmounts", () => {
    render(<DraftHost />);

    fireEvent.change(screen.getByLabelText("继续和 Conductor 对话"), { target: { value: "保留这段后续指令" } });
    fireEvent.click(screen.getByRole("button", { name: "切换页面" }));
    fireEvent.click(screen.getByRole("button", { name: "切换页面" }));

    expect((screen.getByLabelText("继续和 Conductor 对话") as HTMLTextAreaElement).value).toBe("保留这段后续指令");
  });
});
