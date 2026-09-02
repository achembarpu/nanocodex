//! Private owner for one background tool attachment.

use nanocodex_tools::{
    Tools,
    attachment::{Attachment, AttachmentError, AttachmentTarget},
};

#[derive(Clone)]
pub(crate) struct AttachmentSupervisor {
    attachment: Attachment,
}

impl AttachmentSupervisor {
    pub(crate) fn start(tools: Tools, target: AttachmentTarget) -> Result<Self, AttachmentError> {
        let (attachment, _events) = tools.attach(target).start()?;
        Ok(Self { attachment })
    }

    pub(crate) async fn shutdown(&self) -> Result<(), AttachmentError> {
        self.attachment.clone().detach().await
    }
}
