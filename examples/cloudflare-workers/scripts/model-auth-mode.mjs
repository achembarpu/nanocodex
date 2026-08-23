export function brokerPolicyForAuthMode(authMode) {
  if (authMode === "chatgpt") return "codex";
  if (authMode === "api_key") return "openai";
  throw new Error("model auth mode must be api_key or chatgpt");
}
