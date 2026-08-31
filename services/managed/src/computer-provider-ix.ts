import type { Workspace } from "nanocodex/workspace";

import {
  createIxComputerProvider,
  type IxMachineClient,
  type ManagedComputerProvider,
} from "./computer-provider";

/**
 * ix.dev provider for the Cloudflare Managed runtime.
 *
 * The ix browser SDK speaks native WebTransport, which Workerd does not expose.
 * Keep that transport detail out of Managed: a tiny Node 24 broker owns the ix
 * SDK and this Worker talks to it over ordinary authenticated HTTPS. The broker
 * is stateless; every operation reconnects to the ix VM by machine id.
 */
export function createIxBrokerComputerProvider(options: Readonly<{
  brokerToken: string;
  brokerUrl: string;
  fetch?: typeof fetch;
  name?: string;
  region?: string;
  workspace: Workspace;
}>): ManagedComputerProvider {
  if (!options.brokerToken) throw new Error("ix broker token is required");
  const request = options.fetch ?? fetch;
  const baseUrl = options.brokerUrl.replace(/\/$/u, "");
  if (!/^https?:\/\//u.test(baseUrl)) throw new Error("ix broker URL must be HTTP(S)");

  return createIxComputerProvider({
    machines: {
      async create(input = {}) {
        const created = await brokerJson<{ id: string }>(request, options.brokerToken, `${baseUrl}/v1/machines`, {
          method: "POST",
          body: JSON.stringify({
            ...(input.name === undefined ? {} : { name: input.name }),
            ...(input.region === undefined ? {} : { region: input.region }),
          }),
        });
        if (!created.id) throw new Error("ix broker returned no machine id");
        return brokerMachine(request, options.brokerToken, baseUrl, created.id);
      },
    },
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.region === undefined ? {} : { region: options.region }),
    workspace: options.workspace,
  });
}

function brokerMachine(
  request: typeof fetch,
  token: string,
  baseUrl: string,
  id: string,
): IxMachineClient {
  const machineUrl = `${baseUrl}/v1/machines/${encodeURIComponent(id)}`;
  return Object.freeze({
    async delete() {
      await brokerJson(request, token, machineUrl, { method: "DELETE" });
    },
    async exec(argv) {
      return brokerJson(request, token, `${machineUrl}/exec`, {
        method: "POST",
        body: JSON.stringify({ argv }),
      });
    },
    async writeFile(path, contents) {
      await brokerJson(request, token, `${machineUrl}/files`, {
        method: "PUT",
        body: JSON.stringify({ path, base64: encodeBase64(contents) }),
      });
    },
  });
}

async function brokerJson<T = Record<string, never>>(
  request: typeof fetch,
  token: string,
  url: string,
  init: RequestInit,
): Promise<T> {
  const response = await request(url, {
    ...init,
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      ...init.headers,
    },
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`ix broker HTTP ${response.status}: ${text}`);
  if (!text.trim()) return {} as T;
  return JSON.parse(text) as T;
}

function encodeBase64(value: Uint8Array): string {
  let binary = "";
  for (let offset = 0; offset < value.byteLength; offset += 0x8000) {
    binary += String.fromCharCode(...value.subarray(offset, offset + 0x8000));
  }
  return btoa(binary);
}
