"""运行探针的离线检查：连接失败、未迁移和缺失前端均不得报告就绪。"""

from unittest.mock import MagicMock, Mock

from fastapi.testclient import TestClient
import psycopg
import pytest

from src.api.app import create_app
from src.api.health import MigrationError, ReadinessCheck, _WEB_PAGES


@pytest.fixture
def health_app(monkeypatch, tmp_path):
    monkeypatch.setattr("src.api.app.load_dotenv", lambda *_: None)
    monkeypatch.setattr("src.api.app.load_rtc_provider", lambda: None)
    monkeypatch.setattr("src.api.app.SRC_DIR", tmp_path)
    root = tmp_path / "web" / "dist"
    (root / "assets").mkdir(parents=True)
    (root / "assets" / "main.js").write_text("export {};", encoding="utf-8")
    (root / "assets" / "main.css").write_text("body {}", encoding="utf-8")
    for page in _WEB_PAGES:
        (root / f"{page}.html").write_text(
            '<script src="/web/assets/main.js"></script>'
            '<link rel="stylesheet" href="/web/assets/main.css">', encoding="utf-8",
        )
    connect = MagicMock()
    check = Mock()
    monkeypatch.setattr("src.api.health.psycopg.connect", connect)
    monkeypatch.setattr("src.api.health.check_schema", check)
    app = create_app(database_url="postgresql://private-test-credential", media_directory=tmp_path / "media")
    with TestClient(app) as client:
        yield client, connect, check, root


def test_liveness_does_not_require_database_or_frontend(health_app):
    client, connect, _, root = health_app
    connect.side_effect = psycopg.OperationalError("private database connection")
    (root / "index.html").unlink()
    response = client.get("/api/health")
    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
    assert response.headers["cache-control"] == "no-store"
    connect.assert_not_called()


def test_readiness_never_uses_implicit_database_defaults(health_app):
    _, connect, _, root = health_app
    assert ReadinessCheck(" ", root).failure_code() == "DATABASE_UNAVAILABLE"
    connect.assert_not_called()


def test_readiness_checks_database_schema_and_built_pages(health_app):
    client, connect, check, _ = health_app
    response = client.get("/api/ready")
    assert response.status_code == 200
    assert response.json() == {"status": "ready"}
    assert response.headers["cache-control"] == "no-store"
    connection = connect.return_value.__enter__.return_value
    check.assert_called_once_with(connection)
    assert connection.read_only is True
    connection.execute.assert_called_once_with("SET LOCAL statement_timeout = '3s'")
    assert connect.call_args.kwargs == {"connect_timeout": 3}


@pytest.mark.parametrize("failure, expected", [
    (psycopg.OperationalError("private database connection"), "DATABASE_UNAVAILABLE"),
    (MigrationError("private schema details"), "SCHEMA_NOT_READY"),
    (OSError("private migration path"), "SCHEMA_NOT_READY"),
])
def test_readiness_rejects_database_or_schema_failure_without_exposing_details(health_app, failure, expected):
    client, connect, check, _ = health_app
    if isinstance(failure, psycopg.Error):
        connect.side_effect = failure
    else:
        check.side_effect = failure
    response = client.get("/api/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "not_ready", "code": expected}
    assert "private" not in response.text


@pytest.mark.parametrize("missing", ["index.html", "interview.html", "organizing.html", "history.html", "assets/main.js", "assets/main.css"])
def test_readiness_rejects_incomplete_frontend_build(health_app, missing):
    client, _, _, root = health_app
    (root / missing).unlink()
    response = client.get("/api/ready")
    assert response.status_code == 503
    assert response.json() == {"status": "not_ready", "code": "WEB_BUILD_NOT_READY"}
