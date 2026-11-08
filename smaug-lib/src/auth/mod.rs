use std::io::Cursor;

use super::routes::ApiResponse;

use crate::models::{
    AnalysisStateMachineError, FormDefinitionError, ModelError, RunDefinitionError,
};
use crate::utils::SamplesheetError;

mod auth_guard;

pub use auth_guard::*;

use rocket::http::Status;
use rocket::request::Request;
use rocket::response::{self, Responder, Response};

/// What the browser/API gets when an authentication step or an API call fails.
///
/// This is an edge error: routes, request guards and `Responder`s only ever see
/// an [`AuthError`] built from an `anyhow::Error`. The `anyhow::Error` variant is
/// therefore the **unique** `#[from]` variant: the *cause* is inspected there
/// (with `downcast`) to pick the HTTP status and the message shown to the user.
/// The cause chain and the `location` (file:line) recorded by wherror are only
/// logged, never sent to the client.
#[derive(Debug, wherror::Error)]
pub enum AuthError {
    #[error("Identifiants invalides")]
    InvalidCredentials,
    #[error("Utilisateur inconnu")]
    UnknownUser,
    #[error("Pas de mot de passe fourni")]
    NoPassword,
    #[error("Accès réservé aux administrateurs")]
    AdminsOnly,
    #[error("Vous n'avez pas accès à cette ressource")]
    AccessDenied,
    #[error("Signature de webhook invalide")]
    InvalidSignature,
    #[error("Le groupe `{0}` existe déjà!")]
    DuplicateGroup(String),
    #[error("{location}: {source}")]
    AnyhowError {
        #[from]
        source: anyhow::Error,
        location: &'static std::panic::Location<'static>,
    },
}

/// HTTP status of a variant that is not wrapping another error. Single source of
/// truth, used for the error itself and for a downcast cause.
fn status_of(error: &AuthError) -> Status {
    match error {
        AuthError::InvalidCredentials | AuthError::UnknownUser => Status::Unauthorized,
        AuthError::NoPassword | AuthError::InvalidSignature => Status::BadRequest,
        AuthError::AdminsOnly => Status::Forbidden,
        AuthError::AccessDenied => Status::Forbidden,
        AuthError::DuplicateGroup(_) => Status::Conflict,
        AuthError::AnyhowError { .. } => Status::InternalServerError,
    }
}

/// A cause that fails the request because of its input/state rather than because
/// something broke: answered with a status the client can act on.
fn client_error(error: &anyhow::Error) -> Option<(Status, String)> {
    let cause = error.downcast_ref::<AuthError>();
    if let Some(cause) = cause {
        return Some((status_of(cause), cause.to_string()));
    }
    if let Some(cause) = error.downcast_ref::<SamplesheetError>() {
        return Some((Status::BadRequest, cause.to_string()));
    }
    if let Some(cause) = error.downcast_ref::<ModelError>() {
        return match cause {
            ModelError::InvalidInput(_) => Some((Status::BadRequest, cause.to_string())),
            ModelError::InternalError { .. } => None,
        };
    }
    if let Some(cause) = error.downcast_ref::<FormDefinitionError>() {
        return match cause {
            // InternalError only exists for the `#[from]` conversion; it is a bug if
            // it ever reaches an edge.
            FormDefinitionError::InternalError { .. } => None,
            _ => Some((Status::BadRequest, cause.to_string())),
        };
    }
    if let Some(cause) = error.downcast_ref::<RunDefinitionError>() {
        return match cause {
            RunDefinitionError::InternalError { .. } => None,
            _ => Some((Status::Conflict, cause.to_string())),
        };
    }
    if let Some(cause) = error.downcast_ref::<AnalysisStateMachineError>() {
        return match cause {
            AnalysisStateMachineError::InternalError { .. } => None,
            _ => Some((Status::Conflict, cause.to_string())),
        };
    }
    None
}

impl<'r> Responder<'r, 'static> for AuthError {
    fn respond_to(self, _: &'r Request<'_>) -> response::Result<'static> {
        let (status, message) = match &self {
            AuthError::AnyhowError { source, location } => {
                // The full chain and its location are for the server logs only: they
                // contain SQL, filesystem paths and source locations.
                log::error!("Erreur API dans le fichier {location}: {source:#}");
                client_error(source)
                    .unwrap_or((Status::InternalServerError, "Erreur interne".to_string()))
            }
            other => (status_of(other), other.to_string()),
        };

        let body = ApiResponse::<()>::error(message);
        let body_string = rocket::serde::json::to_string(&body)
            .unwrap_or_else(|e| format!(r#"{{"Failure":{{"message":"{e}"}}}}"#));

        let mut response = Response::build();
        response.status(status);
        response.sized_body(body_string.len(), Cursor::new(body_string));
        response.ok()
    }
}
