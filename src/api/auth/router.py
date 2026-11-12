"""注册、登录和当前用户接口，响应不包含密码或数据库凭证摘要。"""

from datetime import datetime

from fastapi import APIRouter, Depends, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, SecretStr

from ...service.auth import AuthError
from .dependencies import get_current_user, get_optional_token


class AuthRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def handle(request: Request):
            try:
                response = await handler(request)
            except RequestValidationError:
                # 默认校验详情可能含原始密码，登录接口只返回简短说明。
                response = JSONResponse({"detail": "账号或密码格式无效"}, status_code=422)
            except AuthError as exc:
                response = JSONResponse({"detail": str(exc)}, status_code=exc.status_code)
                if exc.status_code == 401:
                    response.headers["WWW-Authenticate"] = "Bearer"
            response.headers["Cache-Control"] = "private, no-store"
            return response

        return handle


router = APIRouter(prefix="/api/auth", tags=["账号密码"], route_class=AuthRoute)


class Credentials(BaseModel):
    username: str
    password: SecretStr


class UserResponse(BaseModel):
    id: int
    username: str
    create_time: datetime


class LoginResponse(BaseModel):
    token: str
    user: UserResponse


class GuestUserResponse(UserResponse):
    is_guest: bool


class GuestLoginResponse(BaseModel):
    token: str
    user: GuestUserResponse


@router.post("/register", response_model=UserResponse, status_code=201)
def register(body: Credentials, request: Request, token: str | None = Depends(get_optional_token)):
    return request.app.state.auth.register(
        body.username, body.password.get_secret_value(), guest_token=token,
    )


@router.post("/guest", response_model=GuestLoginResponse, status_code=201)
def start_guest(request: Request):
    raise AuthError("请先注册或登录账号", 403)


@router.post("/login", response_model=LoginResponse)
def login(body: Credentials, request: Request):
    return request.app.state.auth.login(body.username, body.password.get_secret_value())


@router.get("/me")
def me(user: dict = Depends(get_current_user)) -> dict:
    return {"user_id": user["id"], "is_guest": user["is_guest"]}
