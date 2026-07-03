import { describe, expect, it } from "vitest";

async function readStyles() {
  const fsModule = "node:fs";
  const { readFileSync } = (await import(fsModule)) as {
    readFileSync: (path: URL, encoding: "utf8") => string;
  };

  return readFileSync(new URL("../styles.css", import.meta.url), "utf8");
}

describe("responsive layout rules", () => {
  it("stacks the board control area before medium viewports can overflow", async () => {
    const styles = await readStyles();

    expect(styles).toContain("@media (max-width: 1500px)");
    expect(styles).toMatch(/@media \(max-width:\s*1500px\)\s*\{[\s\S]*?\.board-control-row\s*\{[^}]*grid-template-columns:\s*1fr;/);
    expect(styles).toContain("@media (max-width: 1240px)");
    expect(styles).toMatch(/\.board-control-row\s*\{\s*grid-template-columns:\s*1fr;/);
    expect(styles).not.toMatch(
      /\.ide-layout,\s*\.loop-layout,\s*\.kanban,\s*\.board-control-row,\s*\.capability-layout,/,
    );
  });

  it("keeps compact board content from forcing horizontal page scroll", async () => {
    const styles = await readStyles();

    expect(styles).toMatch(/#root\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;[^}]*overflow-x:\s*hidden;/s);
    expect(styles).toMatch(/\.app-shell\s*\{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*hidden;/s);
    expect(styles).toMatch(/\.workspace\s*\{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*hidden;/s);
    expect(styles).toMatch(/\.workspace > \*\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s);
    expect(styles).toMatch(/\.topbar > \*,\s*\.board-toolbar > \*\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s);
    expect(styles).toMatch(/\.rail\s*\{[^}]*max-width:\s*100%;[^}]*overflow-x:\s*hidden;/s);
    expect(styles).toMatch(/\.panel,\s*\.scheme-panel\s*\{[^}]*max-width:\s*100%;/s);
    expect(styles).toMatch(/\.backlog-layout,\s*\.board-with-detail,\s*\.kanban\s*\{[^}]*max-width:\s*100%;/s);
    expect(styles).toMatch(/\.status-pill\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*word-break:\s*break-word;/s);
    expect(styles).toMatch(
      /\.panel > \*,\s*\.lane > \*,\s*\.task-card > \*,\s*\.flow-step > \*,\s*\.health-item > \*\s*\{[^}]*min-width:\s*0;/s,
    );
    expect(styles).toMatch(/\.evidence-box\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s);
    expect(styles).toMatch(
      /\.loop-health,\s*\.task-summary-panel,\s*\.task-detail-panel,\s*\.lane\s*\{[^}]*overflow:\s*hidden;/s,
    );
  });

  it("caps page-level grids so child content cannot widen the shell", async () => {
    const styles = await readStyles();

    expect(styles).toMatch(
      /\.design-grid,\s*\.ide-layout,\s*\.loop-layout,\s*\.board-control-row,\s*\.capability-layout,\s*\.terminals-layout,\s*\.review-layout,\s*\.teams-layout,\s*\.projects-layout,\s*\.mcp-layout,\s*\.browser-layout,\s*\.runs-layout,\s*\.library-layout,\s*\.watcher-layout,\s*\.notifications-layout,\s*\.restore-layout,\s*\.audit-layout\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s,
    );
  });

  it("keeps task board grids shrinkable instead of relying on fixed minimum columns", async () => {
    const styles = await readStyles();

    expect(styles).toMatch(/\.task-flow\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(180px,\s*100%\),\s*1fr\)\);/s);
    expect(styles).toMatch(/\.task-summary-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(170px,\s*100%\),\s*1fr\)\);/s);
    expect(styles).toMatch(/\.detail-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(180px,\s*100%\),\s*1fr\)\);/s);
    expect(styles).toMatch(/\.kanban\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(280px,\s*100%\),\s*1fr\)\);/s);
    expect(styles).toMatch(/\.toolbar-pills span\s*\{[^}]*white-space:\s*normal;/s);
  });

  it("keeps grouped hub navigation shrinkable on narrow viewports", async () => {
    const styles = await readStyles();

    expect(styles).toMatch(/\.hub-layout\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s);
    expect(styles).toMatch(/\.hub-panel\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s);
    expect(styles).toMatch(/\.hub-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(240px,\s*100%\),\s*1fr\)\);/s);
    expect(styles).toMatch(/\.hub-card\s*\{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.hub-card strong,\s*\.hub-card p\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  });

  it("keeps the four-agent workbench list visible without forcing an inner scrollbar", async () => {
    const styles = await readStyles();

    expect(styles).toMatch(
      /\.conversation-agent-panel \.agent-list\.expanded\s*\{[^}]*max-height:\s*none;[^}]*overflow:\s*visible;/s,
    );
    expect(styles).not.toMatch(/\.conversation-agent-panel \.agent-list\.expanded\s*\{[^}]*max-height:\s*132px;/s);
    expect(styles).not.toMatch(/\.conversation-agent-panel \.agent-list\.expanded\s*\{[^}]*overflow:\s*auto;/s);
    expect(styles).toMatch(/\.task-progress-counts\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/s);
    expect(styles).not.toMatch(/\.task-progress-track\s*\{[^}]*overflow:\s*auto;/s);
  });

  it("keeps real permission attention static instead of continuously shaking", async () => {
    const styles = await readStyles();

    expect(styles).toContain(".permission-alert");
    expect(styles).not.toContain("permission-nudge");
    expect(styles).not.toMatch(/\.permission-alert\s*\{[^}]*animation:/s);
  });

  it("does not use document min-width to create page-level horizontal scroll", async () => {
    const styles = await readStyles();

    expect(styles).not.toMatch(/html\s*\{[^}]*min-width:\s*360px;/s);
    expect(styles).not.toMatch(/body\s*\{[^}]*min-width:\s*360px;/s);
    expect(styles).toMatch(/html\s*\{[^}]*max-width:\s*100%;/s);
    expect(styles).toMatch(/body\s*\{[^}]*max-width:\s*100%;/s);
  });

  it("keeps the shell side rail on desktop widths and switches to top navigation only on narrow pages", async () => {
    const styles = await readStyles();

    expect(styles).not.toContain("@media (max-width: 1080px)");
    expect(styles).toMatch(/@media \(max-width:\s*860px\)\s*\{[\s\S]*?\.app-shell\s*\{[^}]*display:\s*block;/);
    expect(styles).toMatch(/@media \(max-width:\s*860px\)\s*\{[\s\S]*?\.rail\s*\{[^}]*position:\s*static;[^}]*height:\s*auto;/);
    expect(styles).toMatch(/@media \(max-width:\s*860px\)\s*\{[\s\S]*?\.nav-list\s*\{[^}]*grid-template-columns:\s*repeat\(2,\s*minmax\(0,\s*1fr\)\);/);
  });

  it("allows browser chrome and long inline values to wrap instead of overflowing", async () => {
    const styles = await readStyles();

    expect(styles).toMatch(/\.browser-chrome\s*\{[^}]*min-width:\s*0;[^}]*flex-wrap:\s*wrap;/s);
    expect(styles).toMatch(/\.browser-chrome span\s*\{[^}]*overflow-wrap:\s*anywhere;[^}]*white-space:\s*normal;/s);
    expect(styles).toMatch(/\.run-history-row span\s*\{[^}]*min-width:\s*0;[^}]*overflow-wrap:\s*anywhere;/s);
  });

  it("keeps capability map matrices shrinkable on narrow viewports", async () => {
    const styles = await readStyles();

    expect(styles).toMatch(/\.state-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(240px,\s*100%\),\s*1fr\)\);/s);
    expect(styles).toMatch(/\.state-card\s*\{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.state-card strong,\s*\.state-card p\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(styles).toMatch(/\.surface-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(260px,\s*100%\),\s*1fr\)\);/s);
    expect(styles).toMatch(/\.surface-card\s*\{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.surface-card strong,\s*\.surface-card p\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(styles).toMatch(/\.model-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(260px,\s*100%\),\s*1fr\)\);/s);
    expect(styles).toMatch(/\.model-card\s*\{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.model-card strong,\s*\.model-card p\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(styles).toMatch(/\.permission-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(260px,\s*100%\),\s*1fr\)\);/s);
    expect(styles).toMatch(/\.permission-card\s*\{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.permission-card strong,\s*\.permission-card p\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(styles).toMatch(/\.context-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(260px,\s*100%\),\s*1fr\)\);/s);
    expect(styles).toMatch(/\.context-card\s*\{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.context-card strong,\s*\.context-card p\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(styles).toMatch(/\.workflow-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(260px,\s*100%\),\s*1fr\)\);/s);
    expect(styles).toMatch(/\.workflow-card\s*\{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.workflow-card strong,\s*\.workflow-card p\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
    expect(styles).toMatch(/\.control-grid\s*\{[^}]*grid-template-columns:\s*repeat\(auto-fit,\s*minmax\(min\(260px,\s*100%\),\s*1fr\)\);/s);
    expect(styles).toMatch(/\.control-card\s*\{[^}]*min-width:\s*0;/s);
    expect(styles).toMatch(/\.control-card strong,\s*\.control-card p\s*\{[^}]*overflow-wrap:\s*anywhere;/s);
  });

  it("keeps the IDE workbench scratchpad from forcing horizontal page scroll", async () => {
    const styles = await readStyles();

    expect(styles).toMatch(/\.project-panel,\s*\.terminal-panel,\s*\.review-side\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s);
    expect(styles).toMatch(/\.scratchpad-box\s*\{[^}]*min-width:\s*0;[^}]*max-width:\s*100%;/s);
    expect(styles).toMatch(/\.scratchpad-tools,\s*\.scratchpad-attachments\s*\{[^}]*flex-wrap:\s*wrap;/s);
    expect(styles).toMatch(/\.scratchpad-chip code\s*\{[^}]*max-width:\s*280px;[^}]*font-family:/s);
    expect(styles).toMatch(/\.composer\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)\s*minmax\(150px,\s*auto\);/s);
  });
});
