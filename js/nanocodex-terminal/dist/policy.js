export const COARSE_POINTER_QUERY = "(pointer: coarse), (any-pointer: coarse)";
export function terminalComposerAction(running, _draft) {
    return running ? "stop" : "send";
}
