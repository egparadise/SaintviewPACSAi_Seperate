"""가입 구조 — hospital 라이선스·결재 + account 가입자 정보 (37차)

Revision ID: d3a4b5c6e7f8
Revises: c2d3e4f5a6b7
Create Date: 2026-06-13
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d3a4b5c6e7f8"
down_revision: Union[str, Sequence[str], None] = "c2d3e4f5a6b7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    for name, col in [
        ("fax", sa.String(64)),
        ("homepage", sa.String(256)),
        ("departments", sa.String(256)),
        ("billing_method", sa.String(24)),
        ("billing_card_last4", sa.String(4)),
    ]:
        op.add_column("hospitals", sa.Column(name, col, nullable=False, server_default=""))
    op.add_column("hospitals", sa.Column("license_clients", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("hospitals", sa.Column("modality_limit", sa.Integer(), nullable=False, server_default="0"))

    for name, col in [
        ("title", sa.String(64)),
        ("sex", sa.String(8)),
        ("birth6", sa.String(6)),
        ("phone", sa.String(32)),
        ("mobile", sa.String(32)),
    ]:
        op.add_column("accounts", sa.Column(name, col, nullable=False, server_default=""))


def downgrade() -> None:
    for name in ("mobile", "phone", "birth6", "sex", "title"):
        op.drop_column("accounts", name)
    for name in ("modality_limit", "license_clients", "billing_card_last4",
                 "billing_method", "departments", "homepage", "fax"):
        op.drop_column("hospitals", name)
