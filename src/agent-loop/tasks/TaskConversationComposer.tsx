import { Square } from "lucide-react";

type Continuity = {
  state: "connected" | "recovery_required" | "stopping" | "closed";
  message: string;
};

/**
 * The Task page is the only user-input surface for a live Run. Sending is the
 * user's continuation action. If the Host connection has disappeared, Runtime
 * reattaches or restarts the Conductor behind that one action.
 */
export function TaskConversationComposer({
  disabled,
  message,
  continuity,
  onMessageChange,
  onSubmit,
  onStop,
}: {
  disabled: boolean;
  /** Owned by the Task surface so a page switch never discards a draft. */
  message: string;
  continuity?: Continuity;
  onMessageChange: (message: string) => void;
  onSubmit: (message: string) => Promise<void>;
  onStop: () => void;
}) {
  const submit = async (event: import("react").FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (disabled || !message.trim()) return;
    await onSubmit(message.trim());
  };

  return <form className="harness-conductor-composer" onSubmit={(event) => void submit(event)}>
    <label>继续和 Conductor 对话
      <textarea id="task-conductor-message" rows={2} disabled={disabled} value={message} onChange={(event) => onMessageChange(event.target.value)} placeholder="补充目标、纠正结论，或要求 Conductor 再次核实；由 Conductor 决定是否重新派发。" />
    </label>
    {continuity && <p className={`harness-composer-status ${continuity.state}`}>{continuity.message}</p>}
    <footer>
      <button className="harness-secondary-button compact danger" disabled={disabled} type="button" onClick={onStop}><Square size={13} /> 停止任务</button>
      <span />
      <button className="harness-primary-button compact" disabled={disabled || !message.trim()} type="submit">发送</button>
    </footer>
  </form>;
}
