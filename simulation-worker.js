/* global importScripts, loadPyodide */

"use strict";

const PYODIDE_VERSION = "0.27.2";
const PYODIDE_BASE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const ASSET_VERSION = new URL(self.location.href).searchParams.get("v");

function simulationAssetUrl(path) {
    const url = new URL(path, self.location.href);
    if (ASSET_VERSION) url.searchParams.set("v", ASSET_VERSION);
    return url.href;
}

const CORE_URL = simulationAssetUrl("simulation_core.py");
const CONTRACT_URL = simulationAssetUrl("scenario-contract.json");
const JOS3_WHEEL_URL = simulationAssetUrl("vendor/jos3-0.5.0-py3-none-any.whl");

let pyodidePromise;
let latestRequestId = 0;
let queuedWork = Promise.resolve();

function postEngineStatus(status, detail = "") {
    self.postMessage({ type: "engine-status", status, detail });
}

function postRequestStatus(requestId, status) {
    self.postMessage({ type: "request-status", id: requestId, status });
}

async function getPyodide() {
    if (!pyodidePromise) {
        const loading = (async () => {
            postEngineStatus("loading");
            importScripts(`${PYODIDE_BASE_URL}pyodide.js`);
            const runtime = await loadPyodide({ indexURL: PYODIDE_BASE_URL });
            await runtime.loadPackage(["numpy", "micropip"]);

            const fetchAsset = async (url, name) => {
                const response = await fetch(url);
                if (!response.ok) {
                    throw new Error(`Could not load ${name} (${response.status})`);
                }
                return response.text();
            };
            const [coreSource, contractSource] = await Promise.all([
                fetchAsset(CORE_URL, "simulation core"),
                fetchAsset(CONTRACT_URL, "scenario contract"),
            ]);
            runtime.FS.writeFile("/home/pyodide/simulation_core.py", coreSource);
            runtime.FS.writeFile("/home/pyodide/scenario-contract.json", contractSource);
            runtime.globals.set("htm_jos3_wheel_url", JOS3_WHEEL_URL);
            await runtime.runPythonAsync(`
import micropip
await micropip.install(htm_jos3_wheel_url)
`);
            await runtime.runPythonAsync(`
import sys
sys.path.insert(0, "/home/pyodide")
from simulation_core import _json_sanitize, simulate_scenario
`);
            postEngineStatus("ready");
            return runtime;
        })();
        pyodidePromise = loading.catch(error => {
            pyodidePromise = undefined;
            postEngineStatus("error", error instanceof Error ? error.message : String(error));
            throw error;
        });
    }
    return pyodidePromise;
}

async function runRequest(requestId, scenario) {
    if (requestId !== latestRequestId) return;

    const runtime = await getPyodide();
    if (requestId !== latestRequestId) return;

    postRequestStatus(requestId, "running");
    runtime.globals.set("htm_scenario_json", JSON.stringify(scenario));
    const resultProxy = await runtime.runPythonAsync(`
import json
scenario = json.loads(htm_scenario_json)
result = simulate_scenario(scenario)
json.dumps(_json_sanitize(result), ensure_ascii=False, separators=(",", ":"))
`);
    const resultJson = resultProxy && typeof resultProxy.toJs === "function"
        ? resultProxy.toJs()
        : resultProxy;
    if (resultProxy && typeof resultProxy.destroy === "function") {
        resultProxy.destroy();
    }
    if (requestId === latestRequestId) {
        self.postMessage({ type: "result", id: requestId, result: JSON.parse(resultJson) });
    }
}

self.onmessage = event => {
    const message = event.data || {};
    if (message.type === "warmup") {
        getPyodide().catch(() => { });
        return;
    }
    if (message.type !== "simulate") return;

    const requestId = Number(message.id);
    latestRequestId = requestId;
    queuedWork = queuedWork
        .then(() => runRequest(requestId, message.scenario))
        .catch(error => {
            if (requestId === latestRequestId) {
                self.postMessage({
                    type: "error",
                    id: requestId,
                    error: error instanceof Error ? error.message : String(error),
                });
            }
        });
};
