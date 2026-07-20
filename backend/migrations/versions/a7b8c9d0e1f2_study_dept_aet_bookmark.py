"""17차 — studies.department/source_aet/bookmark (UBPACS Filter Setting 컬럼 충족)

Revision ID: a7b8c9d0e1f2
Revises: f6a7b8c9d0e1
Create Date: 2026-06-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "a7b8c9d0e1f2"
down_revision: Union[str, Sequence[str], None] = "f6a7b8c9d0e1"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("studies", sa.Column("department", sa.String(64), nullable=False, server_default=""))
    op.add_column("studies", sa.Column("source_aet", sa.String(32), nullable=False, server_default=""))
    op.add_column("studies", sa.Column("bookmark", sa.Boolean(), nullable=False, server_default=sa.false()))


def downgrade() -> None:
    op.drop_column("studies", "bookmark")
    op.drop_column("studies", "source_aet")
    op.drop_column("studies", "department")
