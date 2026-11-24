"""注册、登录和当前用户接口，响应不包含密码或数据库凭证摘要。"""

from datetime import datetime

from fastapi import APIRouter, Depends, Request, Response
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from fastapi.routing import APIRoute
from pydantic import BaseModel, SecretStr

from ...service.auth import AuthError
from ...service.auth.service import public_session_id
from ...service.auth.sms import SmsSendError
from .dependencies import SESSION_COOKIE, bound_token, checked_session_token, cookie_mode, get_session_user, request_token


class AuthRoute(APIRoute):
    def get_route_handler(self):
        handler = super().get_route_handler()

        async def handle(request: Request):
            try:
                response = await handler(request)
            except RequestValidationError:
                # 默认校验详情可能含原始密码、手机号或验证码。
                detail = "手机号或验证码格式无效" if self.path.startswith("/api/auth/sms/") else "账号或密码格式无效"
                response = JSONResponse({"detail": detail}, status_code=422)
            except SmsSendError as exc:
                body = {"detail": str(exc), "code": exc.code}
                headers = {}
                if exc.retry_after is not None:
                    body["retry_after"] = exc.retry_after
                    headers["Retry-After"] = str(exc.retry_after)
                if exc.rate_limit_code:
                    body["rate_limit_code"] = exc.rate_limit_code
                if exc.captcha is not None:
                    body["captcha"] = exc.captcha
                response = JSONResponse(body, status_code=exc.status_code, headers=headers)
            except AuthError as exc:
                response = JSONResponse({"detail": str(exc)}, status_code=exc.status_code)
                if exc.status_code == 401:
                    response.headers["WWW-Authenticate"] = "Bearer"
            response.headers["Cache-Control"] = "private, no-store"
            return response

        return handle


router = APIRouter(prefix="/api/auth", tags=["账号登录"], route_class=AuthRoute, dependencies=[Depends(cookie_mode)])


class Credentials(BaseModel):
    username: str
    password: SecretStr


class SmsCodeRequest(BaseModel):
    phone: str


class SmsCaptchaAnswer(BaseModel):
    id: str
    answer: SecretStr


class SmsSendRequest(SmsCodeRequest):
    captcha: SmsCaptchaAnswer | None = None


class SmsCaptchaResponse(BaseModel):
    id: str
    image: str


class SmsLoginRequest(SmsCodeRequest):
    code: SecretStr


class SmsCodeResponse(BaseModel):
    expires_in: int
    retry_after: int
    rate_limit_code: str | None = None


class UserResponse(BaseModel):
    id: int
    username: str
    create_time: datetime


class LoginResponse(BaseModel):
    token: str
    user: UserResponse


class BrowserLoginResponse(BaseModel):
    user: UserResponse
    session_id: str


def login_response(result: dict, browser: bool, request: Request, response: Response) -> dict:
    if not browser:
        return result
    response.set_cookie(
        SESSION_COOKIE, result["token"], max_age=30 * 24 * 60 * 60, path="/",
        secure=request.url.scheme == "https", httponly=True, samesite="lax",
    )
    return {"user": result["user"], "session_id": public_session_id(result["token"])}


class GuestUserResponse(UserResponse):
    is_guest: bool


class GuestLoginResponse(BaseModel):
    token: str
    user: GuestUserResponse


@router.post("/register", response_model=UserResponse | BrowserLoginResponse, status_code=201)
def register(
    body: Credentials, request: Request, response: Response,
    token: str | None = Depends(bound_token), browser: bool = Depends(cookie_mode),
):
    result = request.app.state.auth.register(
        body.username, body.password.get_secret_value(), guest_token=token, create_session=browser,
    )
    return login_response(result, browser, request, response)


@router.post("/guest", response_model=GuestLoginResponse, status_code=201)
def start_guest(request: Request):
    raise AuthError("请先注册或登录账号", 403)


@router.post("/login", response_model=LoginResponse | BrowserLoginResponse, dependencies=[Depends(bound_token)])
def login(body: Credentials, request: Request, response: Response, browser: bool = Depends(cookie_mode)):
    result = request.app.state.auth.login(body.username, body.password.get_secret_value(), browser=browser)
    return login_response(result, browser, request, response)


def sms_client_ip(request: Request) -> str:
    # 使用 ASGI 服务器解析后的对端地址，验证码接口不自行解释转发头。
    return request.client.host if request.client else "unknown"


@router.post("/sms/send", response_model=SmsCodeResponse, response_model_exclude_none=True, summary="发送手机登录验证码")
def send_sms_code(body: SmsSendRequest, request: Request):
    captcha = body.captcha
    return request.app.state.sms_auth.send_code(
        body.phone, sms_client_ip(request), captcha_id=captcha.id if captcha else None,
        captcha_answer=captcha.answer.get_secret_value() if captcha else None,
    )


@router.post("/sms/captcha", response_model=SmsCaptchaResponse, summary="更换重发短信所需的图片验证码")
def refresh_sms_captcha(body: SmsCodeRequest, request: Request):
    return request.app.state.sms_auth.refresh_captcha(body.phone, sms_client_ip(request))


@router.post("/sms/login", response_model=LoginResponse | BrowserLoginResponse, dependencies=[Depends(bound_token)],
             summary="验证码登录，首次验证成功创建手机账号")
def sms_login(body: SmsLoginRequest, request: Request, response: Response, browser: bool = Depends(cookie_mode)):
    result = request.app.state.sms_auth.login(body.phone, body.code.get_secret_value(), browser=browser)
    return login_response(result, browser, request, response)


@router.post("/session/upgrade", response_model=BrowserLoginResponse)
def upgrade_session(
    request: Request, response: Response, token: str | None = Depends(bound_token), browser: bool = Depends(cookie_mode),
) -> dict:
    if not browser:
        raise AuthError("请从当前站点发起会话升级", 403)
    if not token or "authorization" not in request.headers:
        raise AuthError("请重新登录", 401)
    return login_response(request.app.state.auth.upgrade_session(token), browser, request, response)


@router.get("/me")
def me(
    user: dict = Depends(get_session_user), token: str | None = Depends(request_token), browser: bool = Depends(cookie_mode),
) -> dict:
    result = {"user_id": user["id"], "is_guest": user["is_guest"]}
    if browser:
        result["session_id"] = public_session_id(token)
    return result


@router.post("/logout", status_code=204, response_class=Response)
def logout(
    request: Request, response: Response, token: str | None = Depends(request_token), browser: bool = Depends(cookie_mode),
) -> None:
    if token:
        token = checked_session_token(request, token, browser, require_bound=True)
        if token:
            request.app.state.auth.logout(token)
    if browser and request.cookies.get(SESSION_COOKIE):
        response.delete_cookie(SESSION_COOKIE, path="/", secure=request.url.scheme == "https", httponly=True, samesite="lax")
