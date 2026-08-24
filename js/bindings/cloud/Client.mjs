import { connectActions } from "./Decorator.mjs";
import { iframe } from "./Dialog.mjs";
import { http } from "./Transport.mjs";
import { Provider, postMessage } from "accounts";

let sequence = 0;

export function create(parameters) {
  if (!parameters || typeof parameters.appId !== "string" || parameters.appId.length === 0) {
    throw new TypeError("Client.create requires appId");
  }
  const transport = parameters.transport ?? http();
  const dialog = parameters.dialog ?? iframe();
  const transportInstance = transport.setup({ appId: parameters.appId });
  const dialogInstance = dialog.setup({ appId: parameters.appId });
  const provider = parameters.provider ?? Provider.create({
    adapter: postMessage({
      host: dialogInstance.host,
      name: parameters.name ?? "Nanocodex Connect",
      rdns: `xyz.nanocodex.${parameters.appId}`,
      target: (options) => dialogInstance.walletTarget(options),
    }),
    auth: parameters.auth,
    accessKey: parameters.accessKey,
    mpp: false,
  });
  const uid = `${transport.key}:${parameters.appId}:${++sequence}`;
  let sessionToken;

  const base = {
    accessKey: parameters.accessKey,
    appId: parameters.appId,
    auth: parameters.auth,
    dialog: dialogInstance,
    key: parameters.key ?? "connect",
    name: parameters.name ?? "Nanocodex Connect",
    provider,
    request: (request) => transportInstance.request({
      ...request,
      headers: sessionToken
        ? { ...request.headers, authorization: `Bearer ${sessionToken}` }
        : request.headers,
    }),
    transport: Object.freeze({
      key: transport.key,
      name: transport.name,
      type: transport.type,
      baseUrl: transportInstance.baseUrl,
    }),
    type: "connect",
    uid,
  };

  Object.defineProperty(base, "_setSessionToken", {
    enumerable: false,
    value(token) {
      sessionToken = token;
    },
  });

  function extend(decorator) {
    if (typeof decorator !== "function") throw new TypeError("client extension must be a function");
    const extension = decorator(client);
    const next = Object.create(Object.getPrototypeOf(client));
    Object.defineProperties(next, Object.getOwnPropertyDescriptors(client));
    return Object.assign(next, extension);
  }

  let client = Object.assign(base, { extend });
  client = client.extend(connectActions());
  return Object.freeze(client);
}
