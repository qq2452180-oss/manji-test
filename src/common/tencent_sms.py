"""通过腾讯云短信单发登录验证码。"""

from __future__ import annotations

from dataclasses import dataclass, field
import logging
import os

# 腾讯 SDK 的 DEBUG 日志包含手机号、模板参数和签名请求头。
logging.getLogger("tencentcloud_sdk_common").addFilter(lambda record: record.levelno >= logging.WARNING)


class SmsDeliveryError(RuntimeError):
    """供应商未确认受理这次发送。"""


@dataclass(frozen=True)
class TencentSmsSender:
    secret_id: str = field(repr=False)
    secret_key: str = field(repr=False)
    sdk_app_id: str
    sign_name: str
    template_id: str
    region: str = "ap-guangzhou"

    @classmethod
    def from_env(cls) -> TencentSmsSender | None:
        settings = {
            name: os.getenv(f"SMS_{name.upper()}", "").strip()
            for name in ("secret_id", "secret_key", "sdk_app_id", "sign_name", "template_id")
        }
        if not all(settings.values()):
            return None
        region = os.getenv("SMS_REGION", "").strip() or "ap-guangzhou"
        return cls(**settings, region=region)

    def send_code(self, phone: str, code: str, *, valid_minutes: int) -> None:
        try:
            from tencentcloud.common.credential import Credential
            from tencentcloud.common.exception.tencent_cloud_sdk_exception import TencentCloudSDKException
            from tencentcloud.common.profile.client_profile import ClientProfile
            from tencentcloud.common.profile.http_profile import HttpProfile
            from tencentcloud.common.retry import NoopRetryer
            from tencentcloud.sms.v20210111.models import SendSmsRequest
            from tencentcloud.sms.v20210111.sms_client import SmsClient
        except ImportError:
            raise SmsDeliveryError("短信服务暂时不可用") from None

        try:
            profile = ClientProfile(httpProfile=HttpProfile(reqTimeout=5), retryer=NoopRetryer())
            client = SmsClient(Credential(self.secret_id, self.secret_key), self.region, profile)
            request = SendSmsRequest()
            request.SmsSdkAppId = self.sdk_app_id
            request.SignName = self.sign_name
            request.TemplateId = self.template_id
            request.PhoneNumberSet = [phone]
            request.TemplateParamSet = [code, str(valid_minutes)]
            statuses = client.SendSms(request).SendStatusSet
        except TencentCloudSDKException:
            raise SmsDeliveryError("暂时无法发送短信，请稍后重试") from None
        if not (statuses and len(statuses) == 1 and statuses[0].PhoneNumber == phone
                and statuses[0].Code == "Ok"):
            raise SmsDeliveryError("暂时无法发送短信，请稍后重试")
