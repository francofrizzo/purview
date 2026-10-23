import { afterEach, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  cleanup: undefined as undefined | (() => void),
  qc: { getQueryData: vi.fn(), setQueryData: vi.fn(), invalidateQueries: vi.fn() },
}));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useRef: (current: unknown) => ({ current }),
  useEffect: (effect: () => (() => void)) => { harness.cleanup = effect(); },
}));
vi.mock("@tanstack/react-query", async (original) => ({
  ...await original<typeof import("@tanstack/react-query")>(),
  useQueryClient: () => harness.qc,
}));
import { useAnalysisEvents } from "./hooks";

class Source {
  static current: Source;
  listeners = new Map<string, (event: { data: string }) => void>();
  closed = false;
  constructor() { Source.current = this; }
  addEventListener(name: string, fn: (event: { data: string }) => void) { this.listeners.set(name, fn); }
  removeEventListener(name: string) { this.listeners.delete(name); }
  close() { this.closed = true; }
  send(data: unknown) { this.listeners.get("analysis-job")?.({ data: JSON.stringify(data) }); }
}
afterEach(() => { harness.cleanup?.(); vi.unstubAllGlobals(); vi.clearAllMocks(); });

it("seeds a completed replay without refetching, but refetches once for a live completion", () => {
  vi.stubGlobal("EventSource", Source);
  useAnalysisEvents("github.com/acme/widgets/1");
  const source = Source.current;
  source.send({ type: "analysis-job", job: { status: "done" }, replay: true });
  expect(harness.qc.setQueryData).toHaveBeenCalledTimes(1);
  expect(harness.qc.invalidateQueries).not.toHaveBeenCalled();
  source.send({ type: "analysis-job", job: { status: "running" } });
  source.send({ type: "analysis-job", job: { status: "done" } });
  expect(harness.qc.invalidateQueries).toHaveBeenCalledTimes(2);
  source.send({ type: "analysis-job", job: { status: "done" } });
  source.send({ type: "analysis-job", job: { status: "done" }, replay: true });
  expect(harness.qc.invalidateQueries).toHaveBeenCalledTimes(2);
  harness.cleanup?.();
  expect(source.closed).toBe(true);
});

it("does not suppress a first live completion when there is no stored job", () => {
  vi.stubGlobal("EventSource", Source);
  useAnalysisEvents("github.com/acme/widgets/1");
  Source.current.send({ type: "analysis-job", job: null, replay: true });
  expect(harness.qc.invalidateQueries).not.toHaveBeenCalled();
  Source.current.send({ type: "analysis-job", job: { status: "done" } });
  expect(harness.qc.invalidateQueries).toHaveBeenCalledTimes(2);
});
