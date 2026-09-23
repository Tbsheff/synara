import type { SynaraPluginDescriptor } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { invokePluginMessageAction } from "./PluginMessageAction";

const plugin: SynaraPluginDescriptor = {
  id: "example",
  displayName: "Example",
  version: "1.0.0",
  apiVersion: 1,
  generation: 1,
};

describe("PluginMessageActionItems", () => {
  it("passes a narrow message reference and only includes selectedText for selections", async () => {
    const run = vi.fn().mockResolvedValue(undefined);
    const action = {
      id: "review",
      title: "Review",
      run,
      plugin,
    };
    await invokePluginMessageAction({
      action,
      context: { projectId: "project-1", threadId: "thread-1" },
      message: { id: "message-1", role: "assistant", text: "Full reply" },
      selectedText: "quoted",
    });
    expect(run.mock.calls[0]?.[0]).toEqual({
      context: { projectId: "project-1", threadId: "thread-1" },
      message: { id: "message-1", role: "assistant", text: "Full reply" },
      plugin: action.plugin,
      selectedText: "quoted",
    });

    run.mockClear();
    await invokePluginMessageAction({
      action,
      context: { projectId: "project-1", threadId: "thread-1" },
      message: { id: "message-1", role: "assistant", text: "Full reply" },
    });
    expect(run.mock.calls[0]?.[0]).not.toHaveProperty("selectedText");
  });

  it("contains rejected plugin actions without an unhandled rejection", async () => {
    const onError = vi.fn();
    await invokePluginMessageAction({
      action: {
        id: "fail",
        title: "Fail",
        run: () => Promise.reject(new Error("failed")),
        plugin,
      },
      context: { projectId: null, threadId: null },
      message: { id: "message-1", role: "user", text: "Prompt" },
      onError,
    });
    expect(onError).toHaveBeenCalledWith(expect.any(Error), "example", "fail");
  });
});
