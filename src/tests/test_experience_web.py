"""体验入口使用 src/web 构建产物，静态页面不访问模型或数据库。"""

from unittest.mock import Mock

from fastapi.testclient import TestClient

from src.api import app as application


def test_experience_entry_and_built_pages(monkeypatch, tmp_path):
    source = tmp_path / "src"
    dist = source / "web" / "dist"
    dist.mkdir(parents=True)
    for page in ("index", "welcome", "experience", "login", "interview", "story"):
        (dist / f"{page}.html").write_text(f"<!doctype html><title>{page}</title>")
    monkeypatch.setattr(application, "SRC_DIR", source)
    monkeypatch.setattr(application, "load_dotenv", Mock())
    monkeypatch.setattr(application, "load_rtc_provider", lambda: None)
    connect = Mock(side_effect=AssertionError("静态入口不访问数据库"))
    monkeypatch.setattr("psycopg.connect", connect)
    with TestClient(application.create_app(database_url="", media_directory=tmp_path / "media")) as client:
        response = client.get("/", follow_redirects=False)
        assert response.status_code == 307
        assert response.headers["location"] == "/web/index.html"
        assert client.get("/").url.path == "/web/index.html"
        for page in ("index", "welcome", "experience", "login", "interview", "story"):
            assert client.get(f"/web/{page}.html").status_code == 200
        for path in ("/web/.env", "/web/src/main.js", "/web2/welcome.html"):
            assert client.get(path).status_code == 404
    connect.assert_not_called()
