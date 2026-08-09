/* global importScripts, loadPyodide */

"use strict";

const PYODIDE_VERSION = "0.27.2";
const PYODIDE_BASE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;
const CORE_URL = new URL("simulation_core.py", self.location.href).href;
const JOS3_WHEEL_URL = new URL(
    "vendor/jos3-0.5.0-py3-none-any.whl",
    self.location.href,
).href;

let pyodidePromise;
let latestRequestId = 0;
let queuedWork = Promise.resolve();

function postStatus(status, detail = "") {
    self.postMessage({ type: "status", status, detail });
}

async function getPyodide() {
    if (!pyodidePromise) {
        pyodidePromise = (async () => {
            postStatus("loading");
            importScripts(`${PYODIDE_BASE_URL}pyodide.js`);
            const runtime = await loadPyodide({ indexURL: PYODIDE_BASE_URL });
            await runtime.loadPackage(["numpy", "micropip"]);

            const coreSource = await fetch(CORE_URL).then(response => {
                if (!response.ok) {
                    throw new Error(`Could not load simulation core (${response.status})`);
                }
                return response.text();
            });
            runtime.FS.writeFile("/home/pyodide/simulation_core.py", coreSource);
            runtime.globals.set("htm_jos3_wheel_url", JOS3_WHEEL_URL);
            await runtime.runPythonAsync(`
import micropip
await micropip.install(htm_jos3_wheel_url)
`);
            await runtime.runPythonAsync(`
import sys
sys.path.insert(0, "/home/pyodide")
from simulation_core import _json_sanitize, simulate_jos3
`);
            postStatus("ready");
            return runtime;
        })().catch(error => {
            postStatus("error", error instanceof Error ? error.message : String(error));
            throw error;
        });
    }
    return pyodidePromise;
}

async function runRequest(requestId, payload) {
    if (requestId !== latestRequestId) return;

    const runtime = await getPyodide();
    if (requestId !== latestRequestId) return;

    runtime.globals.set("htm_payload_json", JSON.stringify(payload));
    const resultProxy = await runtime.runPythonAsync(`
import json
result = simulate_jos3(json.loads(htm_payload_json))
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
    if (message.type !== "simulate") return;

    const requestId = Number(message.id);
    latestRequestId = requestId;
    queuedWork = queuedWork
        .then(() => runRequest(requestId, message.payload))
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
