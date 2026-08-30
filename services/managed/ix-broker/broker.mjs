import { createServer } from "node:http";

const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function createIxBrokerServer({ machines, token }) {
  if (!token) throw new Error("NANOCODEX_IX_BROKER_TOKEN is required");
  return createServer(async (request, response) => {
    try {
      if (request.headers.authorization !== `Bearer ${token}`) {
        return json(response, 401, { error: "unauthorized" });
      }
      const url = new URL(request.url ?? "/", "http://localhost");
      if (request.method === "POST" && url.pathname === "/v1/machines") {
        const input = await readJson(request);
        const machine = await machines.create({
          ...(typeof input.name === "string" ? { name: input.name } : {}),
          ...(typeof input.region === "string" ? { region: input.region } : {}),
        });
        return json(response, 201, { id: machine.id });
      }

      const match = /^\/v1\/machines\/([^/]+)(?:\/(exec|files))?$/u.exec(url.pathname);
      if (!match) return json(response, 404, { error: "not_found" });
      const id = decodeURIComponent(match[1]);
      const action = match[2];
      const machine = machines.connect(id);

      if (request.method === "DELETE" && action === undefined) {
        await machine.delete();
        return json(response, 200, {});
      }
      if (request.method === "POST" && action === "exec") {
        const input = await readJson(request);
        if (!Array.isArray(input.argv) || !input.argv.every((part) => typeof part === "string")) {
          return json(response, 400, { error: "argv must be a string array" });
        }
        const result = await machine.exec(input.argv);
        return json(response, 200, {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
        });
      }
      if (request.method === "PUT" && action === "files") {
        const input = await readJson(request);
        if (typeof input.path !== "string" || typeof input.base64 !== "string") {
          return json(response, 400, { error: "path and base64 are required" });
        }
        await machine.writeFile(input.path, Buffer.from(input.base64, "base64"));
        return json(response, 200, {});
      }
      return json(response, 405, { error: "method_not_allowed" });
    } catch (error) {
      return json(response, 500, {
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });
}

async function readJson(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body too large");
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks).toString("utf8");
  return body ? JSON.parse(body) : {};
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
