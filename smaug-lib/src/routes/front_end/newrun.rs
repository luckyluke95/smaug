use crate::models::{CachedForm, FileIdentification, Form};
use crate::routes::frontend::FrontendError;
use crate::templates::{Template, context};
use anyhow::Context;
use rocket::http::uri::{Segments, fmt::Path};
use rocket::{State, get};
use sqlx::SqlitePool;

use crate::auth::Authenticated;

#[get("/runs/submit/branch/<branch>/<file_path..>")]
pub async fn new_run_get(
    auth: Authenticated,
    branch: &str,
    file_path: Segments<'_, Path>,
    pool: &State<SqlitePool>,
) -> Result<Template, FrontendError> {
    let form_path = file_path
        .to_path_buf(true)
        .map_err(|e| anyhow::anyhow!("Chemin de formulaire invalide: {e:?}"))?;

    // A user must not be able to open a form they cannot see, even when they
    // know its full branch/path.
    let can_access = CachedForm::user_can_access(
        pool,
        auth.user.id,
        auth.user.is_admin,
        branch,
        &form_path.to_string_lossy(),
    )
    .await?;
    if !can_access {
        return Ok(Template::render(
            "common/error",
            context! {
                title=> "Accès refusé",
                h2=> "Accès refusé",
                message=> "Vous n'avez pas les permissions nécessaires pour lancer cette analyse",
                user=> &auth.user,
            },
        ));
    }

    let form = Form::get_form(FileIdentification::GitBranchAndPath {
        branch: branch.to_string(),
        file_path: form_path,
    })
    .await
    .with_context(|| "Impossible de récupérer le formulaire demandé")?;
    let variables: Vec<String> = form.variables.iter().map(|v| v.to_html_safe()).collect();
    Ok(Template::render(
        "common/editrun",
        context! {
            form=> form,
            user_defined_vars=> &variables,
            user=>&auth.user
        },
    ))
}
