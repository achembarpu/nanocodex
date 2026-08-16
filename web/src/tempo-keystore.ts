import { Keystore } from "accounts";

/** A cloneable key handle lets the page-authorized signer rehydrate in the Worker. */
export function tempoAccessKeyKeystores() {
  return {
    p256: Keystore.webCryptoP256({ extractable: true }),
  };
}
