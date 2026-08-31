export function captureBrowserAuthority(options) {
  return Object.freeze({
    fetch: options.fetch,
    headers: Object.freeze([...new Headers(options.headers).entries()]
      .map(([name, value]) => Object.freeze([name, value]))),
  });
}

export function sameBrowserAuthority(left, right) {
  return left.fetch === right.fetch
    && left.headers.length === right.headers.length
    && left.headers.every(([name, value], index) => (
      name === right.headers[index][0] && value === right.headers[index][1]
    ));
}
