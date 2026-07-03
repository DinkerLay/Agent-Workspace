import { Blocks, Brain, Library, Sparkles } from "lucide-react";
import type { LibraryItem, PromptLibrarySave } from "../types";
import { StatusPill } from "../components/common";

export function Libraries({
  items,
  activePromptTemplateId,
  attachedSkillIds,
  promptLibrarySaves,
  onInjectPrompt,
  onAttachSkill,
}: {
  items: LibraryItem[];
  activePromptTemplateId?: string;
  attachedSkillIds: string[];
  promptLibrarySaves: PromptLibrarySave[];
  onInjectPrompt: (itemId: string) => void;
  onAttachSkill: (itemId: string) => void;
}) {
  const prompts = items.filter((item) => item.kind === "prompt");
  const skills = items.filter((item) => item.kind === "skill");

  return (
    <section className="library-layout">
      <div className="panel">
        <div className="section-title">
          <Library size={18} />
          <span>Prompt Library</span>
        </div>
        {prompts.map((item) => (
          <div className="library-row" key={item.id}>
            <Sparkles size={16} />
            <span>{item.name}</span>
            <small>{item.scope}</small>
            {activePromptTemplateId === item.id ? <StatusPill status="Selected prompt" /> : null}
            <button
              aria-label={`Send ${item.name} to active agent`}
              className="small-action"
              type="button"
              onClick={() => onInjectPrompt(item.id)}
            >
              Send to active agent
            </button>
          </div>
        ))}
        <div className="export-box">
          <strong>Project prompt store</strong>
          <span>.agent-workspace/prompts.json · .agent-workspace/prompts-personal.json</span>
        </div>
        <div className="library-save-list">
          <div className="section-title compact">
            <Library size={16} />
            <span>Saved scratchpad drafts</span>
          </div>
          {promptLibrarySaves.length ? (
            promptLibrarySaves.map((save) => (
              <article className="library-save-card" key={save.id}>
                <div>
                  <strong>{save.taskId}</strong>
                  <span>{save.savedAt}</span>
                </div>
                <code>{save.artifactPath}</code>
                <small>
                  {save.sourceDraftPath} {"->"} {save.targetPath}
                </small>
              </article>
            ))
          ) : (
            <span className="library-empty">No scratchpad drafts saved yet</span>
          )}
        </div>
      </div>
      <div className="panel">
        <div className="section-title">
          <Brain size={18} />
          <span>Skills Library</span>
        </div>
        {skills.map((item) => (
          <div className="library-row" key={item.id}>
            <Blocks size={16} />
            <span>{item.name}</span>
            <small>{item.target}</small>
            {attachedSkillIds.includes(item.id) ? <StatusPill status="Attached to active task" /> : null}
            <button
              aria-label={`Attach ${item.name}`}
              className="small-action"
              type="button"
              onClick={() => onAttachSkill(item.id)}
            >
              Attach
            </button>
          </div>
        ))}
        <div className="export-box">
          <strong>Export targets</strong>
          <span>Claude Code · Cursor · Windsurf · Codex AGENTS.md · Aider</span>
        </div>
        <div className="export-box instruction-contract">
          <strong>Runtime injection contract</strong>
          <span>canonical SKILL.md</span>
          <span>Codex AGENTS.md managed block</span>
          <span>Injected when task starts; Workbench/Loop still own execution</span>
        </div>
      </div>
    </section>
  );
}
