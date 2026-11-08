use rocket::{State, get, serde::json::Json};
use serde_json::{Map, Value, json};
use sqlx::SqlitePool;

use crate::auth::{AuthError, Authenticated};
use crate::models::{CachedForm, Group};
use crate::routes::ApiResponse;

/// Default number of analysis cards per page on the home page.
const DEFAULT_PAGE_SIZE: i64 = 6;
const MAX_PAGE_SIZE: i64 = 100;

/// Lowercase, accent-insensitive form used to match user searches.
fn normalize(value: &str) -> String {
    diacritics::remove_diacritics(value).to_lowercase()
}

/// Filters forms by name or description, ignoring case and accents.
fn filter_search(forms: Vec<CachedForm>, search: Option<&str>) -> Vec<CachedForm> {
    let Some(search) = search.map(str::trim).filter(|s| !s.is_empty()) else {
        return forms;
    };
    let needle = normalize(search);
    forms
        .into_iter()
        .filter(|form| {
            normalize(&form.name).contains(&needle)
                || normalize(&form.description).contains(&needle)
        })
        .collect()
}

/// Builds the paginated JSON payload expected by the home page.
///
/// `list_key` is the field holding the forms (`with_group`, `without_group`,
/// `without_groups` or `all`), keeping the existing response shape.
fn paginated_payload(
    list_key: &str,
    forms: Vec<CachedForm>,
    page: Option<i64>,
    page_size: Option<i64>,
) -> Value {
    let page_size = page_size
        .unwrap_or(DEFAULT_PAGE_SIZE)
        .clamp(1, MAX_PAGE_SIZE);
    let current_page = page.unwrap_or(1).max(1);
    let total_count = forms.len() as i64;
    let total_pages = ((total_count + page_size - 1) / page_size).max(1);
    let offset = ((current_page - 1) * page_size).max(0) as usize;

    let page_forms: Vec<CachedForm> = forms
        .into_iter()
        .skip(offset)
        .take(page_size as usize)
        .collect();

    let mut payload = Map::new();
    payload.insert(
        list_key.to_string(),
        serde_json::to_value(page_forms).unwrap_or_else(|_| Value::Array(Vec::new())),
    );
    payload.insert(
        "pagination".to_string(),
        json!({
            "current_page": current_page,
            "total_pages": total_pages,
            "page_size": page_size,
            "total_count": total_count,
        }),
    );
    Value::Object(payload)
}

/// Lists every cached FormDef straight from the database (no HTTP request to the git
/// repository). The cache is rebuilt by `POST /smaug/api/update/cache`
/// (see `forms_cache.rs`).
#[get("/forms/all")]
pub async fn get_all_forms(
    pool: &State<SqlitePool>,
) -> Result<Json<ApiResponse<Vec<CachedForm>>>, AuthError> {
    let alldefs = CachedForm::get_all(pool).await?;
    Ok(Json(ApiResponse::success(alldefs)))
}

/// Lists cached FormDefs (with their `form_def_id`, `branch`, `file_path`) visible
/// to the specified group, paginated.
///
/// If no group is specified, returns the forms with no group associated
/// (admins only); other users get an empty page.
#[get("/groups/forms/<group_id>?<page>&<page_size>&<search>")]
pub async fn get_all_forms_for_group(
    pool: &State<SqlitePool>,
    group_id: Option<i64>,
    page: Option<i64>,
    page_size: Option<i64>,
    search: Option<String>,
    auth: Authenticated,
) -> Result<Json<ApiResponse<Value>>, AuthError> {
    let list_key = match group_id {
        Some(_) => "with_group",
        None => "without_group",
    };

    // A non-admin may only browse their own groups.
    if let Some(group_id) = group_id
        && !auth.user.is_admin
    {
        let user_groups = Group::get_user_groups(pool, auth.user.id).await?;
        if !user_groups.iter().any(|group| group.id == group_id) {
            return Err(AuthError::AccessDenied);
        }
    }

    let forms = if group_id.is_none() && !auth.user.is_admin {
        Vec::new()
    } else {
        CachedForm::get_form_defs_for_group(pool, group_id).await?
    };

    let forms = filter_search(forms, search.as_deref());

    let list_key = if group_id.is_none() && !auth.user.is_admin {
        "without_groups"
    } else {
        list_key
    };

    Ok(Json(ApiResponse::success(paginated_payload(
        list_key, forms, page, page_size,
    ))))
}

/// Lists, paginated, every cached FormDef visible to the current user.
///
/// Admins also see forms without a group. The list is deduplicated across the
/// user's groups.
#[get("/groups/forms/all?<page>&<page_size>&<search>")]
pub async fn get_all_forms_for_user(
    pool: &State<SqlitePool>,
    page: Option<i64>,
    page_size: Option<i64>,
    search: Option<String>,
    auth: Authenticated,
) -> Result<Json<ApiResponse<Value>>, AuthError> {
    let groups = Group::get_user_groups(pool, auth.user.id).await?;
    let group_ids: Vec<i64> = groups.iter().map(|group| group.id).collect();

    let forms = CachedForm::get_form_defs_for_groups(pool, &group_ids, auth.user.is_admin).await?;
    let forms = filter_search(forms, search.as_deref());

    Ok(Json(ApiResponse::success(paginated_payload(
        "all", forms, page, page_size,
    ))))
}
