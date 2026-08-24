/** Signs out the Nanocodex account without revoking its app grant or access key. */
export async function logout(client) {
  try {
    await client.provider.request({ method: "wallet_disconnect" });
  } finally {
    client._clearSession();
  }
}
