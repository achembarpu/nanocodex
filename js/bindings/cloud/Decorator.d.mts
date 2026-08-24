import type { create as createAgent } from "./actions/agent.mjs";
import type { connect, disconnect, reconnect } from "./actions/connection.mjs";
import type { revoke } from "./actions/grant.mjs";
import type { fund, getConfig } from "./actions/machineUsd.mjs";
import type { charge } from "./actions/mpp.mjs";
import type { Client } from "./Client.mjs";

export type ConnectActions = {
  agent: { create(options: createAgent.Options): Promise<createAgent.ReturnType> };
  connection: {
    connect(options: connect.Options): connect.ReturnType;
    disconnect(options?: disconnect.Options | undefined): disconnect.ReturnType;
    reconnect(options?: reconnect.Options | undefined): reconnect.ReturnType;
  };
  grant: { revoke(options: revoke.Options): revoke.ReturnType };
  machineUsd: {
    fund(options: fund.Options): fund.ReturnType;
    getConfig(options?: getConfig.Options | undefined): getConfig.ReturnType;
  };
  mpp: { charge(options: charge.Options): charge.ReturnType };
};

export function connectActions(): (client: Client) => ConnectActions;
