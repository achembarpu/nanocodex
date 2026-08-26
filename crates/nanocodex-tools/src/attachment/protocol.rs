use serde::{Deserialize, Serialize};
use serde_json::Value;

pub(crate) const PROTOCOL_VERSION: u8 = 1;
pub(crate) const MAX_FRAME_BYTES: usize = 256 * 1024;
pub(crate) const MAX_OUTPUT_BYTES: u64 = 128 * 1024;
pub(crate) const MAX_IN_FLIGHT: usize = 64;
pub(crate) const MAX_RECEIPTS: usize = 512;
#[cfg(not(test))]
pub(crate) const HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_secs(20);
#[cfg(test)]
pub(crate) const HEARTBEAT_INTERVAL: std::time::Duration = std::time::Duration::from_millis(200);

#[derive(Debug, Serialize)]
pub(crate) struct Capability {
    pub(crate) name: &'static str,
    pub(crate) version: u8,
}

pub(crate) const fn capabilities() -> [Capability; 1] {
    [Capability {
        name: "tools",
        version: 1,
    }]
}

#[derive(Debug, Serialize)]
#[serde(tag = "type")]
pub(crate) enum HostFrame<'a> {
    #[serde(rename = "attach")]
    Attach {
        protocol_version: u8,
        capability: &'static str,
        host_id: &'a str,
        capabilities: [Capability; 1],
    },
    #[serde(rename = "catalog_publish")]
    CatalogPublish {
        protocol_version: u8,
        capability: &'static str,
        lease_id: &'a str,
        generation: u64,
        catalog_revision: u64,
        catalog_digest: &'a str,
        tools: &'a Value,
    },
    #[serde(rename = "result")]
    Result {
        protocol_version: u8,
        capability: &'static str,
        lease_id: &'a str,
        generation: u64,
        catalog_revision: u64,
        call_id: &'a str,
        outcome: &'a Value,
    },
    #[serde(rename = "cancel_ack")]
    CancelAck {
        protocol_version: u8,
        capability: &'static str,
        lease_id: &'a str,
        generation: u64,
        catalog_revision: u64,
        call_id: &'a str,
        outcome: &'static str,
    },
    #[serde(rename = "ping")]
    Ping {
        protocol_version: u8,
        capability: &'static str,
        lease_id: &'a str,
        generation: u64,
        nonce: &'a str,
    },
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", deny_unknown_fields)]
pub(crate) enum RemoteFrame {
    #[serde(rename = "lease")]
    Lease {
        protocol_version: u8,
        capability: String,
        lease_id: String,
        generation: u64,
        expires_at: u64,
        capabilities: Vec<RemoteCapability>,
    },
    #[serde(rename = "catalog_ack")]
    CatalogAck {
        protocol_version: u8,
        capability: String,
        lease_id: String,
        generation: u64,
        catalog_revision: u64,
        catalog_digest: String,
    },
    #[serde(rename = "call")]
    Call {
        protocol_version: u8,
        capability: String,
        host_id: String,
        lease_id: String,
        generation: u64,
        catalog_revision: u64,
        session_id: String,
        call_id: String,
        model: String,
        name: String,
        input: Value,
        output_token_budget: u64,
        output_byte_budget: u64,
        deadline_at: u64,
    },
    #[serde(rename = "cancel")]
    Cancel {
        protocol_version: u8,
        capability: String,
        lease_id: String,
        generation: u64,
        catalog_revision: u64,
        call_id: String,
    },
    #[serde(rename = "result_ack")]
    ResultAck {
        protocol_version: u8,
        capability: String,
        lease_id: String,
        generation: u64,
        catalog_revision: u64,
        call_id: String,
    },
    #[serde(rename = "pong")]
    Pong {
        protocol_version: u8,
        capability: String,
        lease_id: String,
        generation: u64,
        expires_at: u64,
        #[serde(default)]
        nonce: Option<String>,
    },
    #[serde(rename = "fenced")]
    Fenced {
        protocol_version: u8,
        capability: String,
        lease_id: String,
        generation: u64,
        reason: String,
    },
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(crate) struct RemoteCapability {
    name: String,
    version: u8,
}

impl RemoteFrame {
    pub(crate) const fn kind(&self) -> &'static str {
        match self {
            Self::Lease { .. } => "lease",
            Self::CatalogAck { .. } => "catalog_ack",
            Self::Call { .. } => "call",
            Self::Cancel { .. } => "cancel",
            Self::ResultAck { .. } => "result_ack",
            Self::Pong { .. } => "pong",
            Self::Fenced { .. } => "fenced",
        }
    }

    pub(crate) fn parse(text: &str) -> Result<Self, &'static str> {
        if text.len() > MAX_FRAME_BYTES {
            return Err("frame exceeds 256 KiB");
        }
        let frame: Self = serde_json::from_str(text).map_err(|_| "invalid attachment frame")?;
        frame.validate()?;
        Ok(frame)
    }

    fn validate(&self) -> Result<(), &'static str> {
        let (version, capability) = match self {
            Self::Lease {
                protocol_version,
                capability,
                lease_id,
                generation,
                expires_at,
                capabilities,
            } => {
                if !valid_uuid(lease_id, 4)
                    || !positive(*generation)
                    || !positive(*expires_at)
                    || capabilities.len() != 1
                    || capabilities[0].name != "tools"
                    || capabilities[0].version != 1
                {
                    return Err("invalid lease");
                }
                (*protocol_version, capability)
            }
            Self::CatalogAck {
                protocol_version,
                capability,
                lease_id,
                generation,
                catalog_revision,
                catalog_digest,
            } => {
                if !valid_uuid(lease_id, 4)
                    || !positive(*generation)
                    || !positive(*catalog_revision)
                    || !valid_digest(catalog_digest)
                {
                    return Err("invalid catalog ack");
                }
                (*protocol_version, capability)
            }
            Self::Call {
                protocol_version,
                capability,
                host_id,
                lease_id,
                generation,
                catalog_revision,
                session_id,
                call_id,
                model,
                name,
                input,
                output_token_budget,
                output_byte_budget,
                deadline_at,
            } => {
                if !valid_uuid(host_id, 7)
                    || !valid_uuid(lease_id, 4)
                    || !positive(*generation)
                    || !positive(*catalog_revision)
                    || !valid_identifier(session_id)
                    || !valid_identifier(call_id)
                    || !valid_identifier(model)
                    || !valid_tool_name(name)
                    || !(input.is_object() || input.is_string())
                    || serde_json::to_vec(input).map_or(true, |value| value.len() > 128 * 1024)
                    || !(1..=1_000_000).contains(output_token_budget)
                    || !(1..=MAX_OUTPUT_BYTES).contains(output_byte_budget)
                    || !positive(*deadline_at)
                {
                    return Err("invalid call");
                }
                (*protocol_version, capability)
            }
            Self::Cancel {
                protocol_version,
                capability,
                lease_id,
                generation,
                catalog_revision,
                call_id,
            }
            | Self::ResultAck {
                protocol_version,
                capability,
                lease_id,
                generation,
                catalog_revision,
                call_id,
            } => {
                if !valid_uuid(lease_id, 4)
                    || !positive(*generation)
                    || !positive(*catalog_revision)
                    || !valid_identifier(call_id)
                {
                    return Err("invalid pinned frame");
                }
                (*protocol_version, capability)
            }
            Self::Pong {
                protocol_version,
                capability,
                lease_id,
                generation,
                expires_at,
                nonce,
            } => {
                if !valid_uuid(lease_id, 4)
                    || !positive(*generation)
                    || !positive(*expires_at)
                    || nonce.as_ref().is_some_and(|value| value.len() > 128)
                {
                    return Err("invalid pong");
                }
                (*protocol_version, capability)
            }
            Self::Fenced {
                protocol_version,
                capability,
                lease_id,
                generation,
                reason,
            } => {
                if !valid_uuid(lease_id, 4)
                    || !positive(*generation)
                    || reason.is_empty()
                    || reason.len() > 2048
                {
                    return Err("invalid fence");
                }
                (*protocol_version, capability)
            }
        };
        if version != PROTOCOL_VERSION || capability != "tools" {
            return Err("unsupported protocol");
        }
        Ok(())
    }
}

const fn positive(value: u64) -> bool {
    value > 0 && value <= 9_007_199_254_740_991
}

fn valid_digest(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn valid_uuid(value: &str, version: usize) -> bool {
    uuid::Uuid::parse_str(value).is_ok_and(|identity| {
        identity.to_string() == value && identity.get_version_num() == version
    })
}

fn valid_identifier(value: &str) -> bool {
    value.len() <= 128
        && value
            .as_bytes()
            .first()
            .is_some_and(u8::is_ascii_alphanumeric)
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b':' | b'-'))
}

fn valid_tool_name(value: &str) -> bool {
    valid_identifier(value) && !matches!(value, "exec" | "tool_search" | "wait")
}

#[cfg(test)]
mod tests {
    use super::RemoteFrame;

    #[test]
    fn rejects_a_call_without_complete_pins() {
        assert!(
            RemoteFrame::parse(r#"{"type":"call","protocol_version":1,"capability":"tools"}"#)
                .is_err()
        );
    }

    #[test]
    fn parses_and_bounds_the_pinned_call_model() {
        let frame = r#"{"type":"call","protocol_version":1,"capability":"tools","host_id":"01890f3e-65b2-7cc0-98c4-7f93b54e0a1d","lease_id":"22222222-2222-4222-8222-222222222222","generation":1,"catalog_revision":1,"session_id":"session:1","call_id":"call:1","model":"gpt-5.6-sol","name":"lookup","input":{},"output_token_budget":1000,"output_byte_budget":131072,"deadline_at":1}"#;
        assert!(
            matches!(RemoteFrame::parse(frame), Ok(RemoteFrame::Call { model, .. }) if model == "gpt-5.6-sol")
        );

        let missing = frame.replace("\"model\":\"gpt-5.6-sol\",", "");
        assert!(RemoteFrame::parse(&missing).is_err());
        let oversized = frame.replace("gpt-5.6-sol", &"m".repeat(129));
        assert!(RemoteFrame::parse(&oversized).is_err());
    }
}
