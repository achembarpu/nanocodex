const worker = new Worker(
  new URL("./browserCompatibility.worker.mjs", import.meta.url),
  { type: "module" },
);

worker.addEventListener("message", ({ data }) => {
  document.body.dataset.state = data.ok ? "passed" : "failed";
  document.body.dataset.result = JSON.stringify(data);
  worker.terminate();
});
worker.addEventListener("error", (event) => {
  document.body.dataset.state = "failed";
  document.body.dataset.result = JSON.stringify({
    ok: false,
    error: event.message || "browser compatibility Worker crashed",
  });
  worker.terminate();
});
