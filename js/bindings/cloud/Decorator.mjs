import * as agent from "./actions/agent.mjs";
import * as connection from "./actions/connection.mjs";
import * as grant from "./actions/grant.mjs";
import * as machineUsd from "./actions/machineUsd.mjs";
import * as mpp from "./actions/mpp.mjs";

export function connectActions() {
  return (client) => ({
    agent: {
      create: (options) => agent.create(client, options),
    },
    connection: {
      connect: (options) => connection.connect(client, options),
      disconnect: (options) => connection.disconnect(client, options),
      reconnect: (options) => connection.reconnect(client, options),
    },
    grant: {
      revoke: (options) => grant.revoke(client, options),
    },
    machineUsd: {
      fund: (options) => machineUsd.fund(client, options),
      getConfig: (options) => machineUsd.getConfig(client, options),
    },
    mpp: {
      charge: (options) => mpp.charge(client, options),
    },
  });
}
