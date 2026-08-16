const tempoMcp = Symbol.for("nanocodex.tempo.mcp");

export const DEFAULT_MERCATOR_MCP_URL = "https://mercator.tempoxyz.dev/mcp";

const defaultMercator = (payment) => ({
  url: DEFAULT_MERCATOR_MCP_URL,
  description: "Discovers and composes paid Tempo services and MPP flows.",
  payment,
});

/**
 * Marks an MPP session as a Tempo provider and uses the same wallet policy for
 * Nanocodex's built-in paid Mercator MCP. Generic MPP sessions remain generic.
 */
export function createTempoProvider(options) {
  const session = options?.session;
  if (!session || typeof session.ws !== "function") {
    throw new TypeError("session must provide ws(endpoint)");
  }
  if (!options.payment || !Array.isArray(options.payment.methods) || !options.payment.methods.length) {
    throw new TypeError("Tempo provider payment must include at least one MPPx method");
  }

  const provider = {
    kind: "tempo",
    session,
    ws(endpoint) {
      return session.ws(endpoint);
    },
  };
  if (typeof session.close === "function") {
    provider.close = () => session.close();
  }
  Object.defineProperty(provider, tempoMcp, {
    value: { mercator: defaultMercator(options.payment) },
  });
  return Object.freeze(provider);
}

/**
 * Creates the model session and Mercator payment method from any Accounts SDK
 * provider. Accounts adapters all meet the same getMppxParameters() contract,
 * so wallet selection remains entirely application-owned.
 */
export async function createTempoProviderFromAccounts(options) {
  const wallet = options?.wallet;
  if (!wallet || typeof wallet.getMppxParameters !== "function") {
    throw new TypeError("wallet must provide getMppxParameters(options)");
  }
  const accessKey = options.accessKey;
  const walletParameters = wallet.getMppxParameters(
    accessKey === undefined ? undefined : { accessKey },
  );
  if (!walletParameters || typeof walletParameters.getClient !== "function"
    || typeof walletParameters.resolveAccount !== "function") {
    throw new TypeError("wallet.getMppxParameters() returned invalid MPPx parameters");
  }

  // Keep mppx out of normal/API-key browser bundles. It is loaded only when an
  // application explicitly asks Nanocodex to construct a Tempo wallet path.
  const { tempo } = await import("mppx/client");
  const policy = options.policy ?? {};
  const session = tempo.session.manager({
    ...policy,
    ...options.session,
    ...walletParameters,
  });
  const method = tempo({
    ...policy,
    ...options.mercator,
    ...walletParameters,
  });
  return createTempoProvider({
    session,
    payment: { methods: [method] },
  });
}

/** @internal */
export function resolveMcpServers(provider, configured) {
  if (configured === false) return undefined;
  const defaults = provider?.[tempoMcp];
  if (!defaults) return configured;
  return {
    ...defaults,
    ...configured,
  };
}
