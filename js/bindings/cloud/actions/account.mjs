/** Signs out the Nanocodex account without revoking its app grant or access key. */
export async function logout(client) {
  client._clearSession();
  await client.provider.request({ method: "wallet_disconnect" });
}
