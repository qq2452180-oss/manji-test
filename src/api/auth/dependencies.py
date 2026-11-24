"""浏览器会话与旧 Bearer 客户端共用账号鉴权，业务接口只接受正式账号。"""

from fastapi import Depends, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from ...service.auth import AuthError
from ...service.auth.service import public_session_id


SESSION_COOKIE = "manji_session"
_bearer = HTTPBearer(auto_error=False)
_PRIVATE = {"Cache-Control": "private, no-store"}


def _auth_error(error: AuthError) -> HTTPException:
    headers = {**_PRIVATE, "WWW-Authenticate": "Bearer"} if error.status_code == 401 else _PRIVATE
    return HTTPException(error.status_code, detail=str(error), headers=headers)


def _context_changed() -> HTTPException:
    return HTTPException(409, detail={
        "code": "AUTH_CONTEXT_CHANGED", "message": "登录状态已变化，请重新确认。",
    }, headers=_PRIVATE)


def cookie_mode(request: Request) -> bool:
    modes = request.headers.getlist("x-manji-session")
    if not modes:
        return False
    if modes != ["cookie"]:
        raise HTTPException(400, detail="登录方式无效", headers=_PRIVATE)
    if request.url.scheme != "https" and request.url.hostname not in {"localhost", "127.0.0.1", "::1"}:
        raise HTTPException(403, detail="请使用 HTTPS 登录", headers=_PRIVATE)
    origin = request.headers.getlist("origin")
    fetch_site = request.headers.getlist("sec-fetch-site")
    same_origin = f"{request.url.scheme}://{request.url.netloc}"
    if ((origin and origin != [same_origin]) or (fetch_site and fetch_site != ["same-origin"])
            or (request.method not in {"GET", "HEAD", "OPTIONS"} and not origin and not fetch_site)):
        raise HTTPException(403, detail="请从当前站点发起请求", headers=_PRIVATE)
    return True


def request_token(
    request: Request, browser: bool = Depends(cookie_mode),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str | None:
    authorization = request.headers.getlist("authorization")
    if authorization and (len(authorization) != 1 or credentials is None):
        raise _auth_error(AuthError("请重新登录", 401))
    bearer = credentials.credentials if credentials else None
    cookie = request.cookies.get(SESSION_COOKIE) if browser else None
    if cookie and bearer and cookie != bearer:
        raise _context_changed()
    return cookie or bearer


def checked_session_token(
    request: Request, token: str | None, browser: bool, *, require_bound: bool,
) -> str | None:
    if not browser:
        return token
    expected = request.headers.getlist("x-manji-session-id")
    if not expected:
        # /me 可在新标签页中探测身份。业务请求使用页面已确认的公开标识锁定归属。
        if require_bound and token and request.cookies.get(SESSION_COOKIE):
            raise _context_changed()
        return token
    if expected == ["anonymous"]:
        if token:
            # 过期 cookie 可以被一次新的登录替换。
            try:
                request.app.state.auth.get_user(token)
            except AuthError as exc:
                if exc.status_code == 401:
                    return None
                raise _auth_error(exc) from None
            raise _context_changed()
        return None
    if token is None or len(expected) != 1:
        raise _context_changed()
    try:
        if expected[0] != public_session_id(token):
            raise _context_changed()
    except AuthError as exc:
        raise _auth_error(exc) from None
    return token


def bound_token(
    request: Request, token: str | None = Depends(request_token), browser: bool = Depends(cookie_mode),
) -> str | None:
    return checked_session_token(request, token, browser, require_bound=True)


def _user(request: Request, token: str | None) -> dict:
    try:
        if not token:
            raise AuthError("请重新登录", 401)
        return request.app.state.auth.get_user(token)
    except AuthError as exc:
        raise _auth_error(exc) from None


def get_session_user(
    request: Request, token: str | None = Depends(request_token), browser: bool = Depends(cookie_mode),
) -> dict:
    return _user(request, checked_session_token(request, token, browser, require_bound=False))


def get_current_user(request: Request, token: str | None = Depends(bound_token)) -> dict:
    return _user(request, token)


def get_current_user_id(response: Response, user: dict = Depends(get_current_user)) -> int:
    response.headers.update(_PRIVATE)
    if user["is_guest"]:
        raise HTTPException(403, detail="请先注册或登录账号", headers=_PRIVATE)
    return user["id"]
