export function envLine(name, value) {
  return `${name}=${JSON.stringify(value)}`;
}
