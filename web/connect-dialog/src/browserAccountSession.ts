export async function logoutBrowserAccountSession(
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const response = await fetcher("/webauthn/logout", {
    credentials: "same-origin",
    method: "POST",
  });
  await response.body?.cancel();
  if (!response.ok) {
    throw new Error("The Nanocodex account service could not end this browser session.");
  }
}
