"""add studies.institution/referring_physician/memo — 15차 (UBPACS-Z 조회 컬럼 확장)

Revision ID: e5f6a7b8c9d0
Revises: d3e4f5a6b7c8
Create Date: 2026-06-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e5f6a7b8c9d0"
down_revision: Union[str, Sequence[str], None] = "d3e4f5a6b7c8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("studies", sa.Column("institution", sa.String(128), nullable=False, server_default=""))
    op.add_column("studies", sa.Column("referring_physician", sa.String(128), nullable=False, server_default=""))
    op.add_column("studies", sa.Column("memo", sa.Text(), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("studies", "memo")
    op.drop_column("studies", "referring_physician")
    op.drop_column("studies", "institution")
