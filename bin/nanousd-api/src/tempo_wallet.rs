use alloy::{
    network::NetworkWallet,
    primitives::Address,
    signers::{Error, Signer},
};
use mpp::client::tempo::{signing::TempoPrimitiveSigner, wallet::TempoWallet};
use tempo_alloy::TempoNetwork;
use tempo_primitives::{
    TempoTxEnvelope,
    transaction::{KeychainSignature, TempoSignature, TempoTypedTransaction},
};

/// Adapts Tempo Wallet's P-256 access key to Alloy's provider wallet layer.
#[derive(Clone)]
pub(crate) struct TempoAccessKeyWallet {
    account: Address,
    access_key: Address,
    signer: TempoPrimitiveSigner,
}

impl From<&TempoWallet> for TempoAccessKeyWallet {
    fn from(wallet: &TempoWallet) -> Self {
        Self {
            account: wallet.account,
            access_key: wallet.access_key,
            signer: wallet.signer.clone(),
        }
    }
}

impl std::fmt::Debug for TempoAccessKeyWallet {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter
            .debug_struct("TempoAccessKeyWallet")
            .field("account", &self.account)
            .field("access_key", &self.access_key)
            .finish_non_exhaustive()
    }
}

impl NetworkWallet<TempoNetwork> for TempoAccessKeyWallet {
    fn default_signer_address(&self) -> Address {
        self.account
    }

    fn has_signer_for(&self, address: &Address) -> bool {
        *address == self.account
    }

    fn signer_addresses(&self) -> impl Iterator<Item = Address> {
        std::iter::once(self.account)
    }

    async fn sign_transaction_from(
        &self,
        sender: Address,
        transaction: TempoTypedTransaction,
    ) -> Result<TempoTxEnvelope, Error> {
        if sender != self.account {
            return Err(Error::other(format!(
                "Tempo access key cannot sign for {sender}"
            )));
        }
        let TempoTypedTransaction::AA(transaction) = transaction else {
            return Err(Error::other("Tempo access keys require an AA transaction"));
        };
        let signing_hash =
            KeychainSignature::signing_hash(transaction.signature_hash(), self.account);
        let signature = self.signer.sign_hash(&signing_hash).await?;
        Ok(transaction
            .into_signed(TempoSignature::Keychain(KeychainSignature::new(
                self.account,
                signature,
            )))
            .into())
    }
}
