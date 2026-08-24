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

  function fetchControlPlane(input, init, token = sessionToken) {
    if (typeof transportInstance.fetch !== "function") {
      throw new TypeError("Connect transport does not expose an HTTP fetch boundary");
    }
    const request = input instanceof Request
      ? new Request(input, init)
      : new Request(new URL(String(input), transportInstance.baseUrl), init);
    if (new URL(request.url).origin !== new URL(transportInstance.baseUrl).origin) {
      throw new TypeError("Connect client fetch is restricted to its configured API origin");
    }
    const headers = new Headers(request.headers);
    if (token) headers.set("authorization", `Bearer ${token}`);
    return transportInstance.fetch(new Request(request, { headers }));
  }

  function requestControlPlane(request, token = sessionToken) {
    return transportInstance.request({
      ...request,
      headers: token
        ? { ...request.headers, authorization: `Bearer ${token}` }
        : request.headers,
    });
  }

  const base = {
    accessKey: parameters.accessKey,
    appId: parameters.appId,
    auth: parameters.auth,
    dialog: dialogInstance,
    key: parameters.key ?? "connect",
    name: parameters.name ?? "Nanocodex Connect",
    provider,
    fetch: fetchControlPlane,
    request: requestControlPlane,
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
  Object.defineProperty(base, "_captureSession", {
    enumerable: false,
    value() {
      const token = sessionToken;
      if (typeof token !== "string" || !token) {
        throw new Error("The Connect grant session is unavailable.");
      }
      return Object.freeze({
        token,
        fetch: (input, init) => fetchControlPlane(input, init, token),
        request: (request) => requestControlPlane(request, token),
      });
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
