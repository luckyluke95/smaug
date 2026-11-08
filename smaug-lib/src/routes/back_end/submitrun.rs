use anyhow::Context;
use rocket::serde::json::Json;
use rocket::{State, get, post};
use serde_json::{Value, json};
use sqlx::SqlitePool;
use std::collections::HashMap;
use std::path::PathBuf;

use super::super::ApiResponse;
use crate::auth::{AuthError, Authenticated};
use crate::config::get_smaug_config;

use crate::models::CachedForm;
use crate::models::FileIdentification;
use crate::models::Form;
use crate::models::Run;
use crate::models::RunDefinitionError;
use crate::models::analysis;
use crate::models::hgrun;

/// Ensures the authenticated user is allowed to act on the form behind a run.
///
/// Runs always reference a form by branch and path. A user who cannot see this
/// form (or whose branch is not configured) must not be able to validate,
/// retry or edit the run, even when they know its numeric id.
async fn ensure_run_form_access(
    auth: &Authenticated,
    pool: &SqlitePool,
    run: &Run,
) -> Result<(), AuthError> {
    let (branch, file_path) = match &run.form_identification {
        FileIdentification::GitBranchAndPath { branch, file_path } => {
            (branch.as_str(), file_path.to_string_lossy().to_string())
        }
        _ => return Err(AuthError::AccessDenied),
    };

    if CachedForm::user_can_access(pool, auth.user.id, auth.user.is_admin, branch, &file_path)
        .await?
    {
        Ok(())
    } else {
        Err(AuthError::AccessDenied)
    }
}

/// Route: /smaug/api/newrun
#[post("/newrun", data = "<run>")]
pub async fn newrun_post(
    auth: Authenticated,
    pool: &State<SqlitePool>,
    mut run: Json<Run>,
) -> Result<Json<ApiResponse<Value>>, AuthError> {
    // No matter what was posted, we overwrite the run submitter here anyways
    run.0.user_id = auth.user.id;

    // A user must not be able to submit a form they cannot see (for example by
    // typing the full branch/path of a form belonging to another group).
    ensure_run_form_access(&auth, pool, &run.0).await?;

    let run_id = hgrun::Run::new_run(run.0, pool).await?;
    Ok(Json(ApiResponse::success(
        json!({"message":"Run créé avec succès!","run_id":run_id}),
    )))
}

/// Request body of the live script preview used by the run submission page.
#[derive(Debug, serde::Deserialize)]
pub struct PreviewRequest {
    pub branch: String,
    pub file_path: String,
    #[serde(default)]
    pub user_defined_vars: HashMap<String, String>,
    pub run_name: Option<String>,
}

/// Renders the script that would be executed, given the form values currently
/// filled in by the user. No run is created and nothing is written to disk.
#[post("/preview", data = "<request>")]
pub async fn preview_post(
    auth: Authenticated,
    pool: &State<SqlitePool>,
    request: Json<PreviewRequest>,
) -> Result<Json<ApiResponse<Value>>, AuthError> {
    let request = request.into_inner();

    let can_access = CachedForm::user_can_access(
        pool,
        auth.user.id,
        auth.user.is_admin,
        &request.branch,
        &request.file_path,
    )
    .await?;
    if !can_access {
        return Err(AuthError::AccessDenied);
    }

    let form = Form::get_form(FileIdentification::GitBranchAndPath {
        branch: request.branch,
        file_path: PathBuf::from(&request.file_path),
    })
    .await?;

    // Preview values are not tied to a real run yet: use explicit placeholders
    // so the rendered script remains understandable.
    let analysis_dir = get_smaug_config().analysis_dir;
    let outdir = format!("{analysis_dir}/run-<apercu>");
    let exports_dir = format!("{outdir}/exports-<tentative>");
    let logs_dir = format!("{outdir}/logs-<tentative>");
    let run_name = request.run_name.as_deref().unwrap_or("nouveau-run");

    let context = form.jinja_context(
        &request.user_defined_vars,
        1,
        &outdir,
        &exports_dir,
        &logs_dir,
        0,
        run_name,
    );
    let script = form.render_template(&context).await?;

    Ok(Json(ApiResponse::success(json!({ "script": script }))))
}

/// Route: /smaug/api/validate/<run_id>
#[post("/validate/<run_id>")]
pub async fn validate_run_post(
    auth: Authenticated,
    pool: &State<SqlitePool>,
    run_id: i64,
) -> Result<Json<ApiResponse<Value>>, AuthError> {
    let run = Run::get_run_from_id(run_id, pool).await?;
    ensure_run_form_access(&auth, pool, &run).await?;
    analysis::validate_form(run_id, pool).await?;
    Ok(Json(ApiResponse::success(
        json!({"message":"Run validé avec succès!","run_id":run_id}),
    )))
}

#[get("/retry/<run_id>")]
pub async fn retry_run_get(
    auth: Authenticated,
    pool: &State<SqlitePool>,
    run_id: i64,
) -> Result<Json<ApiResponse<Value>>, AuthError> {
    let run = Run::get_run_from_id(run_id, pool).await?;
    ensure_run_form_access(&auth, pool, &run).await?;
    if let Err(e) = analysis::relaunch_run(run_id, pool).await {
        return Ok(Json(ApiResponse::error(e.to_string())));
    }
    Ok(Json(ApiResponse::success(
        json!({"message":"Le run est à nouveau à valider"}),
    )))
}

/// Route: /smaug/api/editrun/
#[post("/editrun", data = "<run>")]
pub async fn editrun_post(
    auth: Authenticated,
    pool: &State<SqlitePool>,
    run: Json<Run>,
) -> Result<Json<ApiResponse<Value>>, AuthError> {
    let run_id = run.run_id.context(RunDefinitionError::MissingRunID)?;
    let existing = Run::get_run_from_id(run_id, pool).await?;
    ensure_run_form_access(&auth, pool, &existing).await?;
    hgrun::Run::edit_run(run_id, run.0.user_defined_vars, pool).await?;
    Ok(Json(ApiResponse::success(
        json!({"message":"Run modifié avec succès!","run_id":run_id}),
    )))
}
