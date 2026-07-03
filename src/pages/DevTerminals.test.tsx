/**
 * @vitest-environment jsdom
 */
import { fireEvent, render, screen } from "@testing-library/react";
import type { ComponentType } from "react";
import { describe, expect, it } from "vitest";
import { devCommands, runtimeContracts } from "../mock/capabilityData";
import { DevTerminals } from "./DevTerminals";

describe("DevTerminals", () => {
  it("starts and stops commands through explicit command controls", () => {
    const starts: string[] = [];
    const stops: string[] = [];
    const InteractiveDevTerminals = DevTerminals as ComponentType<{
      commands: typeof devCommands;
      contracts: typeof runtimeContracts;
      events: Array<{
        id: string;
        commandId: string;
        action: string;
        status: string;
        summary: string;
        evidencePath: string;
        logPath: string;
        createdAt: string;
      }>;
      onStartCommand: (commandId: string) => void;
      onStopCommand: (commandId: string) => void;
    }>;

    render(
      <InteractiveDevTerminals
        commands={devCommands}
        contracts={runtimeContracts}
        events={[
          {
            id: "dev-command-event-cmd-web-001",
            commandId: "cmd-web",
            action: "start",
            status: "running",
            summary: "Started Frontend dev server through Dev Terminals command manager",
            evidencePath: ".agent-workspace/commands/events.jsonl",
            logPath: ".agent-workspace/commands/cmd-web/log.txt",
            createdAt: "2026-06-24T13:45:00Z",
          },
        ]}
        onStartCommand={(commandId) => starts.push(commandId)}
        onStopCommand={(commandId) => stops.push(commandId)}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Start Local API service" }));
    fireEvent.click(screen.getByRole("button", { name: "Stop Frontend dev server" }));

    expect(starts).toEqual(["cmd-api"]);
    expect(stops).toEqual(["cmd-web"]);
    expect(screen.getByText("Dev Server PTY")).toBeTruthy();
    expect(screen.getByText("One-shot Command")).toBeTruthy();
    expect(screen.getByText("Command lifecycle audit")).toBeTruthy();
    expect(screen.getByText("Started Frontend dev server through Dev Terminals command manager")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/commands/events.jsonl")).toBeTruthy();
    expect(screen.getByText(".agent-workspace/commands/cmd-web/log.txt")).toBeTruthy();
  });
});
