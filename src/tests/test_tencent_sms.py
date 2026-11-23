import json
from unittest.mock import patch

import pytest
from tencentcloud.common.exception.tencent_cloud_sdk_exception import TencentCloudSDKException
from tencentcloud.sms.v20210111.sms_client import SmsClient

from src.common.tencent_sms import SmsDeliveryError, TencentSmsSender


PHONE = "+8613800000000"
CODE = "012345"


@pytest.fixture
def sender(monkeypatch):
    settings = {"SECRET_ID": "test-id", "SECRET_KEY": "test-key", "SDK_APP_ID": "1400000000",
                "SIGN_NAME": "测试签名", "TEMPLATE_ID": "42", "REGION": "ap-guangzhou"}
    for name, value in settings.items():
        monkeypatch.setenv("SMS_" + name, value)
    return TencentSmsSender.from_env()


def test_incomplete_configuration_disables_sender(sender, monkeypatch):
    assert sender is not None
    assert "test-key" not in repr(sender)
    monkeypatch.setenv("SMS_TEMPLATE_ID", "  ")
    assert TencentSmsSender.from_env() is None


def test_send_calls_tencent_with_code_and_valid_minutes(sender):
    response = {"Response": {"SendStatusSet": [{"PhoneNumber": PHONE, "Code": "Ok"}]}}
    with patch.object(SmsClient, "call", autospec=True, return_value=json.dumps(response)) as call:
        assert sender.send_code(PHONE, CODE, valid_minutes=5) is None
    client, action, params = call.call_args.args
    assert client.region == "ap-guangzhou"
    assert client.profile.httpProfile.reqTimeout == 5
    assert action == "SendSms"
    assert params == {"SmsSdkAppId": "1400000000", "SignName": "测试签名", "TemplateId": "42",
                      "PhoneNumberSet": [PHONE], "TemplateParamSet": [CODE, "5"]}


@pytest.mark.parametrize("statuses", [
    [], [{"PhoneNumber": PHONE, "Code": "LimitExceeded"}],
    [{"PhoneNumber": "+8613900000000", "Code": "Ok"}],
])
def test_unaccepted_target_is_a_failure(sender, statuses):
    response = json.dumps({"Response": {"SendStatusSet": statuses}})
    with patch.object(SmsClient, "call", return_value=response), pytest.raises(SmsDeliveryError):
        sender.send_code(PHONE, CODE, valid_minutes=5)


def test_sdk_error_does_not_expose_raw_payload_or_credentials(sender):
    failure = TencentCloudSDKException("ClientNetworkError", f"private {PHONE} {CODE} test-key")
    with patch.object(SmsClient, "call", side_effect=failure) as call, pytest.raises(SmsDeliveryError) as error:
        sender.send_code(PHONE, CODE, valid_minutes=5)
    call.assert_called_once()
    assert str(error.value) == "暂时无法发送短信，请稍后重试"
    assert error.value.__suppress_context__
