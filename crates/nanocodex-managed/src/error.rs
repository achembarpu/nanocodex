use reqwest::StatusCode;

pub(crate) const MAX_RESPONSE_BYTES: usize = 1024 * 1024;

/// Failure returned by the native managed lifecycle transport.
#[derive(Debug, thiserror::Error)]
pub enum ManagedError {
    /// A locally supplied origin, credential, identifier, cursor, or request
    /// violates the managed API contract.
    #[error("{0}")]
    Configuration(String),
    /// The HTTP transport failed before a complete response was available.
    #[error("managed request failed")]
    Transport(#[source] reqwest::Error),
    /// The managed service returned a non-success HTTP response.
    #[error("managed request failed ({status}): {code}: {message}")]
    Http {
        /// HTTP status returned by the service.
        status: StatusCode,
        /// Stable service error code, or an HTTP-derived fallback.
        code: String,
        /// Human-readable service error message.
        message: String,
    },
    /// An ordinary managed response exceeded the fixed one-mebibyte limit.
    #[error("managed response exceeded {MAX_RESPONSE_BYTES} bytes")]
    ResponseTooLarge,
    /// A successful ordinary response violated its typed JSON contract.
    #[error("managed response is malformed: {0}")]
    InvalidResponse(&'static str),
    /// A durable event-stream frame or envelope violated its protocol.
    #[error("managed event stream is malformed: {0}")]
    InvalidEvent(String),
    /// A managed turn reached an unsuccessful terminal state.
    #[error("managed turn {turn_id} {state}: {message}")]
    Turn {
        /// Stable managed turn identifier.
        turn_id: String,
        /// Terminal state returned by the service.
        state: String,
        /// Failure detail returned by the service.
        message: String,
    },
}
