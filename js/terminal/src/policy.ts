export const COARSE_POINTER_QUERY = "(pointer: coarse), (any-pointer: coarse)";

export function terminalComposerAction(running: boolean, draft: string): "send" | "stop" {
  return running && !draft.trim() ? "stop" : "send";
}
