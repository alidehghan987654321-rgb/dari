"""Subscription plans and the payment gateway (Zarinpal).

The flow: create a payment, ask the gateway for an authority code, send the seller to the
gateway's page, and when they come back to /pay/callback ask the gateway to verify the
payment (with the amount we expect) before extending the subscription.

Zarinpal v4 REST (amounts in rial):
  request  POST {host}/pg/v4/payment/request.json  -> data.code 100, data.authority
  pay page      {host}/pg/StartPay/{authority}
  verify   POST {host}/pg/v4/payment/verify.json   -> data.code 100 (or 101: already verified)
"""

from __future__ import annotations

import json
import logging
import secrets
from dataclasses import dataclass
from typing import Protocol
from urllib.parse import urlencode

import httpx

log = logging.getLogger(__name__)


@dataclass(frozen=True)
class Plan:
    id: str
    name_fa: str
    days: int
    price_toman: int

    @property
    def amount_rial(self) -> int:
        return self.price_toman * 10


def default_plans(monthly_toman: int, quarterly_toman: int) -> list[Plan]:
    return [
        Plan("monthly", "اشتراک یک‌ماهه", 30, monthly_toman),
        Plan("quarterly", "اشتراک سه‌ماهه", 90, quarterly_toman),
    ]


class PaymentError(RuntimeError):
    """The gateway refused to start a payment."""


class Gateway(Protocol):
    name: str

    def start(
        self, amount_rial: int, description: str, callback_url: str, email: str, mobile: str
    ) -> tuple[str, str]:
        """Returns (authority, URL to send the payer to)."""
        ...

    def verify(self, authority: str, amount_rial: int) -> str | None:
        """The gateway's reference number if the payment went through, else None."""
        ...


class Zarinpal:
    name = "zarinpal"
    HOSTS = {"live": "https://payment.zarinpal.com", "sandbox": "https://sandbox.zarinpal.com"}

    def __init__(self, merchant_id: str, sandbox: bool = False, client: httpx.Client | None = None):
        self.merchant_id = merchant_id
        self.host = self.HOSTS["sandbox" if sandbox else "live"]
        self.http = client or httpx.Client(timeout=30)

    def _post(self, path: str, body: dict) -> dict:
        r = self.http.post(f"{self.host}{path}", json=body, headers={"Accept": "application/json"})
        try:
            return r.json()
        except json.JSONDecodeError:
            raise PaymentError(f"Zarinpal answered {r.status_code} without JSON") from None

    def start(self, amount_rial, description, callback_url, email, mobile):
        metadata = {k: v for k, v in (("email", email), ("mobile", mobile)) if v}
        body = {
            "merchant_id": self.merchant_id,
            "amount": amount_rial,
            "description": description,
            "callback_url": callback_url,
            "metadata": metadata,
        }
        res = self._post("/pg/v4/payment/request.json", body)
        data = res.get("data") or {}
        if isinstance(data, dict) and data.get("code") == 100 and data.get("authority"):
            authority = data["authority"]
            return authority, f"{self.host}/pg/StartPay/{authority}"
        raise PaymentError(f"Zarinpal refused the payment: {res.get('errors') or res}")

    def verify(self, authority, amount_rial):
        body = {"merchant_id": self.merchant_id, "amount": amount_rial, "authority": authority}
        try:
            res = self._post("/pg/v4/payment/verify.json", body)
        except (httpx.HTTPError, PaymentError):
            log.exception("Zarinpal verify failed for %s", authority)
            return None
        data = res.get("data") or {}
        if isinstance(data, dict) and data.get("code") in (100, 101):
            return str(data.get("ref_id") or authority)
        log.warning("Zarinpal did not verify %s: %s", authority, res.get("errors") or res)
        return None


class DemoGateway:
    """Pretends every payment succeeds. Only for trying the site out locally:
    enabled with HUNTER_PAYMENT=demo, never by default."""

    name = "demo"

    def start(self, amount_rial, description, callback_url, email, mobile):
        authority = "DEMO-" + secrets.token_hex(8)
        sep = "&" if "?" in callback_url else "?"
        return (
            authority,
            f"{callback_url}{sep}{urlencode({'Authority': authority, 'Status': 'OK'})}",
        )

    def verify(self, authority, amount_rial):
        return "DEMO-REF-" + authority[-6:] if authority.startswith("DEMO-") else None
