const AGENT_TOKEN = /^[A-Za-z0-9_-]{43}$/;

export function managedAgentHeaders(agent, initial) {
  const token = managedAgentToken(agent);
  const headers = new Headers(initial);
  headers.set("authorization", `Bearer ${token}`);
  return headers;
}

export async function managedAgentFetch(agent, input, init = {}) {
  return fetch(input, {
    ...init,
    headers: managedAgentHeaders(agent, init.headers),
  });
}

export function managedAgentWebSocketOptions(agent, initial = {}) {
  const headers = managedAgentHeaders(agent, initial.headers);
  return {
    ...initial,
    headers: Object.fromEntries(headers),
  };
}

export function managedAgentToken(agent) {
  if (!agent || typeof agent.agent_token !== "string" || !AGENT_TOKEN.test(agent.agent_token)) {
    throw new Error("managed agent receipt omitted a valid scoped agent_token");
  }
  return agent.agent_token;
}
