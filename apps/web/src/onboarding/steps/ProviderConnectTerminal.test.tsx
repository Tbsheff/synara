import { beforeEach, expect, it, vi } from "vitest";
import { reactHookHarness } from "../../test/reactHookHarness";
import { ProviderConnectTerminal } from "./ProviderConnectTerminal";

const mocks = vi.hoisted(() => ({ run: vi.fn(), close: vi.fn() }));
vi.mock("react", async () => (await import("../../test/reactHookHarness")).reactHookHarnessMock);
vi.mock("~/components/ui/button", () => ({ Button: () => null }));
vi.mock("~/components/ThreadTerminalDrawer", () => ({ default: () => null }));
vi.mock("~/components/terminal/terminalSession", () => ({
  disposeAndCloseTerminalSession: mocks.close,
}));
vi.mock("~/hooks/useTerminalSurfaceController", () => ({
  useTerminalSurfaceController: () => ({
    terminalState: { terminalIds: ["terminal"], activeTerminalId: "terminal", terminalOpen: true },
    openTerminalThreadPage: vi.fn(),
  }),
}));
vi.mock("~/nativeApi", () => ({ readNativeApi: () => ({}) }));
vi.mock("~/projectTerminalRunner", () => ({ runProjectCommandInTerminal: mocks.run }));
vi.mock("~/terminalStateStore", () => ({ useTerminalStateStore: () => vi.fn() }));

beforeEach(() => {
  reactHookHarness.reset();
  mocks.run.mockReset();
});
it("shows a failed sign-in command and lets the user retry", async () => {
  mocks.run.mockRejectedValueOnce(new Error("Could not write sign-in command"));
  const render = () => {
    reactHookHarness.beginRender();
    return ProviderConnectTerminal({
      provider: "codex",
      signInCommand: "codex login",
      cwd: "/project",
    });
  };
  render();
  await Promise.resolve();
  const tree = render();
  const error = tree.props.children[0];
  expect(error?.props.role).toBe("alert");
  expect(error.props.children[0].props.children).toBe("Could not write sign-in command");
  mocks.run.mockResolvedValueOnce(undefined);
  error.props.children[1].props.onClick();
  render();
  await Promise.resolve();
  expect(mocks.run).toHaveBeenCalledTimes(2);
  expect(render().props.children[0]).toBeNull();
});
