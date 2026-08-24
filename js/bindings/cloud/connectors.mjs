const REST_CONNECTORS = Object.freeze(["github", "gmail", "gdrive"]);

export function connectorRequestTools(client, connection, calls) {
  const granted = new Set(
    connection.grant.connectors.filter((provider) => REST_CONNECTORS.includes(provider)),
  );
  if (granted.size === 0) return {};
  const providers = [...granted];
  return {
    connector_request: {
      description: "Make an authenticated request through one of the active grant's GitHub, Gmail, or Google Drive connectors. Credentials remain server-side.",
      parameters: {
        type: "object",
        additionalProperties: false,
        required: ["provider", "path"],
        properties: {
          provider: { type: "string", enum: providers },
          path: { type: "string", minLength: 1 },
          method: { type: "string", enum: ["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"] },
          headers: {
            type: "object",
            additionalProperties: { type: "string" },
          },
          body: { type: "string" },
        },
      },
      async handler(input, context) {
        const request = connectorRequest(input, granted);
        calls.add("connector_request", context);
        return client.request({
          method: "POST",
          path: `/v1/grants/${connection.grant.id}/connectors/${request.provider}/request`,
          body: {
            path: request.path,
            ...(request.method === undefined ? {} : { method: request.method }),
            ...(request.headers === undefined ? {} : { headers: request.headers }),
            ...(request.body === undefined ? {} : { body: request.body }),
          },
          signal: context.signal,
        });
      },
    },
  };
}

function connectorRequest(input, granted) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new TypeError("connector_request input must be an object");
  }
  const provider = input.provider;
  if (typeof provider !== "string" || !granted.has(provider)) {
    throw new TypeError("connector_request provider is not present in the active grant");
  }
  if (provider === "chatgpt") {
    throw new TypeError("connector_request does not permit ChatGPT");
  }
  if (typeof input.path !== "string" || input.path.length === 0) {
    throw new TypeError("connector_request path must be a non-empty string");
  }
  if (
    input.method !== undefined
    && !["DELETE", "GET", "HEAD", "OPTIONS", "PATCH", "POST", "PUT"].includes(input.method)
  ) {
    throw new TypeError("connector_request method is invalid");
  }
  if (
    input.headers !== undefined
    && (
      !input.headers
      || typeof input.headers !== "object"
      || Array.isArray(input.headers)
      || Object.values(input.headers).some((value) => typeof value !== "string")
    )
  ) {
    throw new TypeError("connector_request headers must contain string values");
  }
  if (input.body !== undefined && typeof input.body !== "string") {
    throw new TypeError("connector_request body must be a string");
  }
  return input;
}
