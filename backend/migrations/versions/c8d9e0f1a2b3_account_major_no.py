"""판독의 등록에 전문의 번호(major_no) — 2026-08-10 사용자 확정.

A(원격 PACS) 계정별 doctor_major(전문의 번호)를 로그인 시 자동 채움하고
확정 서명에 면허번호와 함께 기록한다. 없는 계정은 공란.

Revision ID: c8d9e0f1a2b3
Revises: b2c3d4e5f6a7
Create Date: 2026-08-10
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c8d9e0f1a2b3"
down_revision: Union[str, Sequence[str], None] = "b2c3d4e5f6a7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("accounts", sa.Column("major_no", sa.String(32), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("accounts", "major_no")
