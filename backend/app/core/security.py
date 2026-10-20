"""Optional API-key based role access.

When AUTH_ENABLED is false every caller is treated as an operator. Roles:
  viewer   - read-only access
  operator - may acknowledge/resolve anomalies, send commands and control the simulator
"""
from __future__ import annotations

from dataclasses import dataclass

from fastapi import Depends, Header, HTTPException, Request, status

from app.core.config import get_settings

ROLE_RANK = {"viewer": 0, "operator": 1}


@dataclass
class Principal:
    name: str
    role: str


def get_principal(
    request: Request,
    x_api_key: str | None = Header(default=None),
    x_operator: str | None = Header(default=None),
) -> Principal:
    settings = getattr(request.app.state, "settings", None) or get_settings()
    name = (x_operator or "operator").strip()[:64] or "operator"
    if not settings.auth_enabled:
        return Principal(name=name, role="operator")
    role = settings.api_key_roles.get(x_api_key or "")
    if role is None:
        raise HTTPException(status.HTTP_401_UNAUTHORIZED, "Missing or invalid API key")
    return Principal(name=name, role=role)


def require_operator(principal: Principal = Depends(get_principal)) -> Principal:
    if ROLE_RANK.get(principal.role, -1) < ROLE_RANK["operator"]:
        raise HTTPException(status.HTTP_403_FORBIDDEN, "Operator role required")
    return principal
