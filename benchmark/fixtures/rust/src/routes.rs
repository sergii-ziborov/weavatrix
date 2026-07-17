use axum::{routing::get, Router};

use crate::model::User;

async fn get_user() -> String {
    let user = User { id: "benchmark".to_string() };
    user.id
}

pub fn router() -> Router {
    Router::new().route("/api/users/:id", get(get_user))
}
