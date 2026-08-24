import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { SimulationResult, SimulationScenario } from "../domain/types";
import { SimulationClient } from "./simulationClient";

class WorkerDouble extends EventTarget {
  static instances: WorkerDouble[] = [];

  readonly scriptUrl: string | URL;
  readonly postMessage = vi.fn<(message: unknown) => void>();
  readonly terminate = vi.fn<() => void>();

  constructor(scriptUrl: string | URL) {
    super();
    this.scriptUrl = scriptUrl;
    WorkerDouble.instances.push(this);
  }

  emitMessage(data: unknown): void {
    this.dispatchEvent(new MessageEvent("message", { data }));
  }

  emitError(message: string): void {
    this.dispatchEvent(new ErrorEvent("error", { message }));
  }
}

const scenario: SimulationScenario = {
  schemaVersion: 1,
  name: "Baseline scenario",
  subject: {
    sex: "male",
    heightCm: 175,
    weightKg: 70,
    ageYears: 35,
    referenceCoreTempC: 37,
  },
  stages: [
    {
      id: "stage-1",
      name: "Baseline",
      durationMin: 30,
      environment: {
        airTempC: { start: 24, end: 24 },
        windSpeedMs: { start: 0.1, end: 0.1 },
        relativeHumidityPercent: { start: 50, end: 50 },
        solarRadiationWm2: { start: 0, end: 0 },
        mediumThermalConductivityWmK: { start: 0.026, end: 0.026 },
      },
      activityMet: { start: 1.2, end: 1.2 },
      posture: "sitting",
      outfit: [],
    },
  ],
};

const result = { schemaVersion: 1, marker: "result" } as unknown as SimulationResult;
const clients: SimulationClient[] = [];

function createClient(): SimulationClient {
  const client = new SimulationClient();
  clients.push(client);
  return client;
}

beforeEach(() => {
  WorkerDouble.instances = [];
  vi.stubGlobal("Worker", WorkerDouble);
});

afterEach(() => {
  for (const client of clients.splice(0)) {
    client.destroy();
  }
  vi.unstubAllGlobals();
});

describe("SimulationClient", () => {
  it("posts a simulation request and resolves the matching result", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.subscribe(listener);

    const completion = client.run(scenario);
    const worker = WorkerDouble.instances[0];

    const scriptUrl = new URL(String(worker.scriptUrl));
    expect(scriptUrl.pathname).toBe(new URL("simulation-worker.js", document.baseURI).pathname);
    expect(scriptUrl.searchParams.get("v")).toMatch(/^[a-f0-9]{16}$/);
    expect(worker.postMessage).toHaveBeenCalledWith({
      type: "simulate",
      id: 1,
      scenario,
    });
    expect(listener).toHaveBeenLastCalledWith({ status: "loading" });

    worker.emitMessage({ type: "request-status", id: 1, status: "running" });
    expect(listener).toHaveBeenLastCalledWith({ status: "running" });

    worker.emitMessage({ type: "result", id: 1, result });

    await expect(completion).resolves.toBe(result);
    expect(listener).toHaveBeenLastCalledWith({ status: "ready" });
  });

  it("forwards engine status events and honors unsubscription", () => {
    const client = createClient();
    const listener = vi.fn();
    const unsubscribe = client.subscribe(listener);

    client.warmup();
    const worker = WorkerDouble.instances[0];
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "warmup" });
    expect(listener).toHaveBeenLastCalledWith({ status: "loading" });

    worker.emitMessage({ type: "engine-status", status: "loading", detail: "Loading Pyodide" });
    worker.emitMessage({ type: "engine-status", status: "ready" });
    expect(listener.mock.calls).toEqual([
      [{ status: "loading" }],
      [{ status: "loading", detail: "Loading Pyodide" }],
      [{ status: "idle" }],
    ]);

    unsubscribe();
    worker.emitMessage({ type: "request-status", id: 1, status: "running" });
    expect(listener).toHaveBeenCalledTimes(3);
  });

  it("rejects a cancelled run and creates a new worker for the next run", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.subscribe(listener);

    const cancelledRun = client.run(scenario);
    const firstWorker = WorkerDouble.instances[0];

    client.cancel();
    await expect(cancelledRun).rejects.toMatchObject({
      name: "AbortError",
      message: "Simulation cancelled.",
    });
    expect(firstWorker.terminate).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenLastCalledWith({ status: "idle" });

    const nextRun = client.run(scenario);
    const secondWorker = WorkerDouble.instances[1];
    expect(secondWorker).toBeDefined();
    expect(secondWorker).not.toBe(firstWorker);
    expect(secondWorker.postMessage).toHaveBeenCalledWith({
      type: "simulate",
      id: 2,
      scenario,
    });

    secondWorker.emitMessage({ type: "result", id: 2, result });
    await expect(nextRun).resolves.toBe(result);
  });

  it("discards a failed worker and retries with a new worker", async () => {
    const client = createClient();
    const listener = vi.fn();
    client.subscribe(listener);

    const failedRun = client.run(scenario);
    const failedWorker = WorkerDouble.instances[0];

    failedWorker.emitError("Worker initialization failed");
    await expect(failedRun).rejects.toThrow("Worker initialization failed");
    expect(listener).toHaveBeenLastCalledWith({
      status: "error",
      detail: "Worker initialization failed",
    });

    const retry = client.run(scenario);
    const retryWorker = WorkerDouble.instances.at(-1)!;
    retryWorker.emitMessage({ type: "result", id: 2, result });
    await expect(retry).resolves.toBe(result);

    expect(WorkerDouble.instances).toHaveLength(2);
    expect(retryWorker).not.toBe(failedWorker);
    expect(failedWorker.terminate).toHaveBeenCalledOnce();
  });
});
