"""clients — 38차 (병원 Client 좌석·접속 상태)

Revision ID: e4b5c6d7f8a9
Revises: d3a4b5c6e7f8
Create Date: 2026-06-13
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "e4b5c6d7f8a9"
down_revision: Union[str, Sequence[str], None] = "d3a4b5c6e7f8"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "clients",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("hospital_id", sa.Integer(), sa.ForeignKey("hospitals.id"), nullable=False),
        sa.Column("name", sa.String(64), nullable=False, server_default=""),
        sa.Column("code", sa.String(32), nullable=False, server_default=""),
        sa.Column("location", sa.String(128), nullable=False, server_default=""),
        sa.Column("enabled", sa.Boolean(), nullable=False, server_default=sa.true()),
        sa.Column("last_seen", sa.DateTime(timezone=True), nullable=True),
        sa.Column("last_user", sa.String(64), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_clients_hospital_id", "clients", ["hospital_id"])


def downgrade() -> None:
    op.drop_index("ix_clients_hospital_id", "clients")
    op.drop_table("clients")
