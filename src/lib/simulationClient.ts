import type { SimulationResult, SimulationScenario } from "../domain/types";

export type SimulationEngineStatus =
  | "idle"
  | "loading"
  | "ready"
  | "running"
  | "error";

export interface SimulationStatusEvent {
  status: SimulationEngineStatus;
  detail?: string;
}

interface PendingRequest {
  id: number;
  resolve: (result: SimulationResult) => void;
  reject: (error: Error) => void;
}

type StatusListener = (event: SimulationStatusEvent) => void;

export class SimulationClient {
  private worker: Worker | null = null;
  private engineReady = false;
  private requestId = 0;
  private pending: PendingRequest | null = null;
  private readonly listeners = new Set<StatusListener>();

  subscribe(listener: StatusListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  warmup(): void {
    const worker = this.ensureWorker();
    if (!this.engineReady) {
      this.emit({ status: "loading" });
    }
    worker.postMessage({ type: "warmup" });
  }

  run(scenario: SimulationScenario): Promise<SimulationResult> {
    if (this.pending) {
      this.cancel();
    }

    const worker = this.ensureWorker();
    const id = ++this.requestId;
    this.emit({ status: this.engineReady ? "running" : "loading" });

    return new Promise<SimulationResult>((resolve, reject) => {
      this.pending = { id, resolve, reject };
      worker.postMessage({ type: "simulate", id, scenario });
    });
  }

  cancel(): void {
    if (this.pending) {
      this.pending.reject(new DOMException("Simulation cancelled.", "AbortError"));
      this.pending = null;
    }
    this.releaseWorker();
    this.emit({ status: "idle" });
  }

  destroy(): void {
    this.cancel();
    this.listeners.clear();
  }

  private ensureWorker(): Worker {
    if (this.worker) {
      return this.worker;
    }

    const workerUrl = new URL("simulation-worker.js", document.baseURI);
    workerUrl.searchParams.set("v", __SIMULATION_ASSET_VERSION__);
    this.worker = new Worker(workerUrl);
    this.worker.addEventListener("message", this.handleMessage);
    this.worker.addEventListener("error", this.handleWorkerError);
    return this.worker;
  }

  private readonly handleMessage = (event: MessageEvent) => {
    if (event.currentTarget !== this.worker) {
      return;
    }
    const message = event.data as Record<string, unknown> | null;
    if (!message) {
      return;
    }

    if (message.type === "engine-status") {
      const status = String(message.status);
      const detail = typeof message.detail === "string" ? message.detail : undefined;
      if (status === "loading") {
        this.emit({ status: "loading", detail });
      } else if (status === "ready") {
        this.engineReady = true;
        if (!this.pending) {
          this.emit({ status: "idle" });
        }
      } else if (status === "error") {
        const error = new Error(detail || "The simulation engine could not start.");
        this.pending?.reject(error);
        this.pending = null;
        this.releaseWorker();
        this.emit({ status: "error", detail: error.message });
      }
      return;
    }

    if (message.type === "request-status") {
      const id = Number(message.id);
      if (this.pending && id === this.pending.id && message.status === "running") {
        this.emit({ status: "running" });
      }
      return;
    }

    const id = Number(message.id);
    if (!this.pending || id !== this.pending.id) {
      return;
    }

    const pending = this.pending;
    this.pending = null;
    if (message.type === "result") {
      pending.resolve(message.result as SimulationResult);
      this.emit({ status: "ready" });
      return;
    }
    if (message.type === "error") {
      const error = new Error(
        typeof message.error === "string" ? message.error : "Simulation failed.",
      );
      pending.reject(error);
      this.releaseWorker();
      this.emit({ status: "error", detail: error.message });
    }
  };

  private readonly handleWorkerError = (event: ErrorEvent) => {
    if (event.currentTarget !== this.worker) {
      return;
    }
    const error = new Error(event.message || "The simulation worker stopped unexpectedly.");
    this.pending?.reject(error);
    this.pending = null;
    this.releaseWorker();
    this.emit({ status: "error", detail: error.message });
  };

  private releaseWorker(): void {
    if (!this.worker) {
      return;
    }
    this.worker.removeEventListener("message", this.handleMessage);
    this.worker.removeEventListener("error", this.handleWorkerError);
    this.worker.terminate();
    this.worker = null;
    this.engineReady = false;
  }

  private emit(event: SimulationStatusEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
