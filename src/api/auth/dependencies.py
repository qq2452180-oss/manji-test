"""业务接口只接受正式账号；身份查询及注册仍兼容旧游客凭据。"""

from fastapi import Depends, HTTPException, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from ...service.auth import AuthError


_bearer = HTTPBearer(auto_error=False)


def get_optional_token(
    request: Request,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> str | None:
    """只在完全没有 Authorization 时视为匿名；畸形或重复凭据必须拒绝。"""
    authorization = request.headers.getlist("authorization")
    if not authorization:
        return None
    if len(authorization) != 1 or credentials is None:
        raise HTTPException(401, detail="请重新登录", headers={
            "Cache-Control": "private, no-store", "WWW-Authenticate": "Bearer",
        })
    return credentials.credentials


def get_current_user(request: Request, token: str | None = Depends(get_optional_token)) -> dict:
    try:
        if token is None:
            raise AuthError("请重新登录", 401)
        return request.app.state.auth.get_user(token)
    except AuthError as exc:
        headers = {"Cache-Control": "private, no-store"}
        if exc.status_code == 401:
            headers["WWW-Authenticate"] = "Bearer"
        raise HTTPException(exc.status_code, detail=str(exc), headers=headers) from None


def get_current_user_id(
    request: Request, response: Response,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> int:
    headers = {"Cache-Control": "private, no-store"}
    response.headers.update(headers)
    try:
        if credentials is None or len(request.headers.getlist("authorization")) != 1:
            raise AuthError("请重新登录", 401)
        user = request.app.state.auth.get_user(credentials.credentials)
        if user["is_guest"]:
            raise AuthError("请先注册或登录账号", 403)
        return user["id"]
    except AuthError as exc:
        if exc.status_code == 401:
            headers["WWW-Authenticate"] = "Bearer"
        raise HTTPException(exc.status_code, detail=str(exc), headers=headers) from None
