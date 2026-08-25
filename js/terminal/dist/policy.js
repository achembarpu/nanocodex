export const COARSE_POINTER_QUERY = "(pointer: coarse), (any-pointer: coarse)";
export function terminalComposerAction(running, draft) {
    return running && !draft.trim() ? "stop" : "send";
}
