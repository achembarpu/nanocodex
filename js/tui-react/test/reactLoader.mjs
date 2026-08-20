const reactRoot = new URL("../node_modules/react/", import.meta.url);

export function resolve(specifier, context, nextResolve) {
  if (specifier === "react") {
    return { shortCircuit: true, url: new URL("index.js", reactRoot).href };
  }
  if (specifier === "react/jsx-runtime") {
    return { shortCircuit: true, url: new URL("jsx-runtime.js", reactRoot).href };
  }
  if (specifier === "react/jsx-dev-runtime") {
    return { shortCircuit: true, url: new URL("jsx-dev-runtime.js", reactRoot).href };
  }
  return nextResolve(specifier, context);
}
