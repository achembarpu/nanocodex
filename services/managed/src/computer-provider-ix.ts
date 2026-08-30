import { Client, type Machine } from "@indexable/sdk";
import type { Workspace } from "nanocodex/workspace";

import {
  createIxComputerProvider,
  type IxMachineClient,
  type ManagedComputerProvider,
} from "./computer-provider";

/**
 * First-class ix.dev backend. Authentication and the default region are owned
 * by the ix SDK (`IX_TOKEN` / `IX_REGION`); Nanocodex only owns the machine
 * lifecycle and workspace projection.
 */
export function createIxSdkComputerProvider(options: Readonly<{
  client?: Client;
  name?: string;
  region?: string;
  workspace: Workspace;
}>): ManagedComputerProvider {
  const client = options.client ?? new Client();
  const machines = client.machines();

  return createIxComputerProvider({
    machines: {
      async create(input = {}) {
        return ixMachine(await machines.create({
          ...(input.name === undefined ? {} : { name: input.name }),
          ...(input.region === undefined ? {} : { region: input.region }),
        }));
      },
    },
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.region === undefined ? {} : { region: options.region }),
    workspace: options.workspace,
  });
}

function ixMachine(machine: Machine): IxMachineClient {
  return Object.freeze({
    async delete() {
      try {
        await machine.delete();
      } finally {
        // `close` releases the local SDK handle after the explicit VM delete.
        // This mirrors ix's own runner implementation and cannot leave a VM
        // alive if handle cleanup itself fails.
        await machine.close();
      }
    },
    async exec(argv) {
      const result = await machine.exec(argv);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
      };
    },
    async writeFile(path, contents) {
      await machine.writeFile(path, contents);
    },
  });
}
