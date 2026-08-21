/** Create the browser Agent in its package-owned module Worker. */
export function create(options = {}) {
  return import("./WorkerAgent.mjs").then(({ createWorkerAgent }) =>
    createWorkerAgent(options));
}
