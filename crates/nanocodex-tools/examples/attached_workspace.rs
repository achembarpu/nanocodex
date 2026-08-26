use nanocodex_tools::{Tools, WorkspaceTools, attachment::AttachmentTarget};

#[tokio::main(flavor = "current_thread")]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let tools = Tools::builder()
        .add(WorkspaceTools::new(std::env::current_dir()?))
        .build()?;
    let target = AttachmentTarget::new("wss://tools.example.test/v1/attach", "bearer")?;
    let attachment = tools.attach(target).connect().await?;
    attachment.detach().await?;
    Ok(())
}
