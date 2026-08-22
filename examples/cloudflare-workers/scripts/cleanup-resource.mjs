export async function deleteWith503Retry(request, {
  description = "resource cleanup",
  timeoutMs = 15_000,
  retryDelayMs = 250,
} = {}) {
  requirePositiveInteger(timeoutMs, "cleanup timeout");
  requirePositiveInteger(retryDelayMs, "cleanup retry delay");
  const startedAt = performance.now();
  let attempts = 0;

  while (true) {
    const remainingMs = timeoutMs - (performance.now() - startedAt);
    if (remainingMs <= 0) throw unavailableError(description, timeoutMs);
    attempts += 1;
    const response = await boundedRequest(request, remainingMs, description);
    if (response.body) void response.body.cancel().catch(() => {});
    if (response.status === 204 || response.status === 404) {
      return { attempts, status: response.status };
    }
    if (response.status !== 503) {
      throw new Error(`${description} returned unexpected HTTP ${response.status}`);
    }

    const retryRemainingMs = timeoutMs - (performance.now() - startedAt);
    if (retryRemainingMs <= 0) throw unavailableError(description, timeoutMs);
    await delay(Math.min(retryDelayMs, retryRemainingMs));
  }
}

async function boundedRequest(request, remainingMs, description) {
  const duration = Math.max(1, Math.ceil(remainingMs));
  const controller = new AbortController();
  const signal = controller.signal;
  const timer = setTimeout(
    () => controller.abort(new Error(`${description} exceeded its bounded deadline`)),
    duration,
  );
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    Promise.resolve()
      .then(() => request(signal))
      .then(resolve, reject)
      .finally(() => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
      });
  });
}

function unavailableError(description, timeoutMs) {
  return new Error(`${description} remained unavailable (HTTP 503) for ${timeoutMs}ms`);
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
