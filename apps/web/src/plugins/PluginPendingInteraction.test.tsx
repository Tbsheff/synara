import type { UserInputQuestion } from "@synara/contracts";
import type { JsonValue } from "@synara/plugin-sdk";
import type { SynaraPluginDescriptor } from "@synara/plugin-sdk/app";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type ActivePluginPendingInteraction,
  parsePluginApprovalDecision,
  parsePluginUserInputAnswers,
  pluginOwnsPendingInteraction,
  PluginPendingInteractionView,
  type PluginPendingInteractionViewProps,
  resolvePluginPendingInteraction,
} from "./PluginPendingInteraction";

const plugin: SynaraPluginDescriptor = {
  id: "acme.interactions",
  displayName: "Acme Interactions",
  version: "1.0.0",
  apiVersion: 2,
  generation: 2,
};

const otherPlugin: SynaraPluginDescriptor = { ...plugin, id: "other.interactions" };

const approvalCard: ActivePluginPendingInteraction = {
  id: "approval-card",
  kind: "approval",
  plugin,
  component: ({ interaction }) => <p>{JSON.stringify(interaction)}</p>,
};

function viewProps(
  overrides: Partial<PluginPendingInteractionViewProps> = {},
): PluginPendingInteractionViewProps {
  return {
    requestKey: "request-1",
    defaultCardRequestKey: null,
    registration: approvalCard,
    context: { projectId: "project-1", threadId: "thread-1" },
    interaction: { requestId: "request-1", ignored: undefined },
    submit: vi.fn(async () => undefined),
    cancel: vi.fn(async () => undefined),
    fallback: <p>Built in</p>,
    onUseDefaultCard: vi.fn(),
    ...overrides,
  };
}

function captureView(props: PluginPendingInteractionViewProps): ReactElement {
  let captured: ReactNode = null;
  function Capture() {
    captured = PluginPendingInteractionView(props);
    return null;
  }
  renderToStaticMarkup(<Capture />);
  if (!isValidElement(captured)) throw new Error("Expected a plugin card element.");
  return captured;
}

function findElementWithText(node: ReactNode, text: string): ReactElement | null {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findElementWithText(child, text);
      if (found) return found;
    }
    return null;
  }
  if (!isValidElement<{ children?: ReactNode }>(node)) return null;
  if (node.props.children === text) return node;
  return findElementWithText(node.props.children, text);
}

const questions: ReadonlyArray<UserInputQuestion> = [
  {
    id: "scope",
    header: "Scope",
    question: "Which scope?",
    options: [
      { label: "Web", description: "Web app" },
      { label: "Server", description: "Server app" },
    ],
    multiSelect: false,
  },
  {
    id: "checks",
    header: "Checks",
    question: "Which checks?",
    options: [
      { label: "Lint", description: "Run lint" },
      { label: "Tests", description: "Run tests" },
    ],
    multiSelect: true,
  },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("PluginPendingInteractionView", () => {
  it("renders the plugin card with a host-owned default card control", () => {
    const markup = renderToStaticMarkup(<PluginPendingInteractionView {...viewProps()} />);

    expect(markup).toContain("request-1");
    expect(markup).not.toContain("ignored");
    expect(markup).not.toContain("Built in");
    expect(markup).toContain("Use default card");
  });

  it("keeps the built-in renderer when no plugin matches", () => {
    const markup = renderToStaticMarkup(
      <PluginPendingInteractionView {...viewProps({ registration: null })} />,
    );

    expect(markup).toContain("Built in");
    expect(markup).not.toContain("Use default card");
  });

  it("switches the request back to the built-in card from the host control", () => {
    const onUseDefaultCard = vi.fn();
    const button = findElementWithText(
      captureView(viewProps({ onUseDefaultCard })),
      "Use default card",
    );
    if (!button) throw new Error("Expected the default card control.");
    (button.props as { onClick: () => void }).onClick();
    expect(onUseDefaultCard).toHaveBeenCalledWith("request-1");

    const markup = renderToStaticMarkup(
      <PluginPendingInteractionView {...viewProps({ defaultCardRequestKey: "request-1" })} />,
    );
    expect(markup).toContain("Built in");
    expect(markup).not.toContain("request-1");

    const nextRequestMarkup = renderToStaticMarkup(
      <PluginPendingInteractionView
        {...viewProps({
          requestKey: "request-2",
          defaultCardRequestKey: "request-1",
          interaction: { requestId: "request-2" },
        })}
      />,
    );
    expect(nextRequestMarkup).toContain("request-2");
    expect(nextRequestMarkup).not.toContain("Built in");
  });

  it("keys the plugin card by request so state cannot leak across requests", () => {
    expect(captureView(viewProps()).key).toBe("request-1");
    expect(captureView(viewProps({ requestKey: "request-2" })).key).toBe("request-2");
  });

  it("rejects instead of throwing when host validation fails synchronously", async () => {
    let pluginSubmit: ((value: JsonValue) => Promise<void>) | null = null;
    const registration: ActivePluginPendingInteraction = {
      ...approvalCard,
      component: ({ submit }) => {
        pluginSubmit = submit;
        return <p>card</p>;
      },
    };
    renderToStaticMarkup(
      <PluginPendingInteractionView
        {...viewProps({
          registration,
          submit: (value) => {
            parsePluginApprovalDecision(value, { sessionApprovalAvailable: false });
            return Promise.resolve();
          },
        })}
      />,
    );

    let result: Promise<void> | undefined;
    expect(() => {
      result = pluginSubmit?.("acceptForSession");
    }).not.toThrow();
    await expect(result).rejects.toThrow("approval responses must be one of");
  });
});

describe("resolvePluginPendingInteraction", () => {
  it("returns the single registration for a kind", () => {
    expect(resolvePluginPendingInteraction([approvalCard], "approval")).toBe(approvalCard);
    expect(resolvePluginPendingInteraction([approvalCard], "userInput")).toBeNull();
  });

  it("warns and uses the built-in card when plugins claim the same kind", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const resolved = resolvePluginPendingInteraction(
      [approvalCard, { ...approvalCard, plugin: otherPlugin }],
      "approval",
    );

    expect(resolved).toBeNull();
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("other.interactions/approval-card"));
    expect(
      renderToStaticMarkup(
        <PluginPendingInteractionView {...viewProps({ registration: resolved })} />,
      ),
    ).toContain("Built in");
  });
});

describe("pluginOwnsPendingInteraction", () => {
  const userInputCard: ActivePluginPendingInteraction = { ...approvalCard, kind: "userInput" };

  it("gives the plugin card ownership of the active question", () => {
    expect(
      pluginOwnsPendingInteraction({
        registration: userInputCard,
        requestKey: "request-1",
        defaultCardRequestKey: null,
      }),
    ).toBe(true);
  });

  it("keeps the built-in flow when no plugin owns the question", () => {
    expect(
      pluginOwnsPendingInteraction({
        registration: userInputCard,
        requestKey: "request-1",
        defaultCardRequestKey: "request-1",
      }),
    ).toBe(false);
    expect(
      pluginOwnsPendingInteraction({
        registration: null,
        requestKey: "request-1",
        defaultCardRequestKey: null,
      }),
    ).toBe(false);
    expect(
      pluginOwnsPendingInteraction({
        registration: userInputCard,
        requestKey: null,
        defaultCardRequestKey: null,
      }),
    ).toBe(false);
  });
});

describe("plugin pending interaction response parsing", () => {
  it("accepts decisions the built-in approval card offers", () => {
    expect(parsePluginApprovalDecision("acceptForSession", {})).toBe("acceptForSession");
    expect(parsePluginApprovalDecision("decline", { sessionApprovalAvailable: false })).toBe(
      "decline",
    );
  });

  it("rejects decisions the built-in approval card hides or does not know", () => {
    expect(() =>
      parsePluginApprovalDecision("acceptForSession", { sessionApprovalAvailable: false }),
    ).toThrow("approval responses must be one of: accept, decline, cancel");
    expect(() => parsePluginApprovalDecision("always", {})).toThrow("approval responses");
  });

  it("accepts complete answers for the pending questions", () => {
    expect(
      parsePluginUserInputAnswers({ scope: " Web ", checks: ["Lint", "Tests"] }, questions),
    ).toEqual({ scope: "Web", checks: ["Lint", "Tests"] });
    expect(parsePluginUserInputAnswers({ scope: "Both", checks: "none" }, questions)).toEqual({
      scope: "Both",
      checks: "none",
    });
  });

  it("rejects malformed, unknown, option-invalid, and incomplete answers", () => {
    expect(() => parsePluginUserInputAnswers([], questions)).toThrow("answer object");
    expect(() => parsePluginUserInputAnswers({}, questions)).toThrow("every pending question");
    expect(() =>
      parsePluginUserInputAnswers({ scope: "Web", checks: ["Lint"], extra: "x" }, questions),
    ).toThrow("extra does not match a pending question");
    expect(() =>
      parsePluginUserInputAnswers({ scope: ["Web"], checks: ["Lint"] }, questions),
    ).toThrow("scope must be text or one option label");
    expect(() =>
      parsePluginUserInputAnswers({ scope: "Web", checks: ["Lint", "Deploy"] }, questions),
    ).toThrow("checks must only select listed options");
    expect(() => parsePluginUserInputAnswers({ scope: "Web", checks: 1 }, questions)).toThrow(
      "checks must be text or a list of option labels",
    );
    expect(() => parsePluginUserInputAnswers({ scope: "Web", checks: [] }, questions)).toThrow(
      "every pending question",
    );
    expect(() => parsePluginUserInputAnswers({ scope: "  ", checks: ["Lint"] }, questions)).toThrow(
      "every pending question",
    );
  });
});
