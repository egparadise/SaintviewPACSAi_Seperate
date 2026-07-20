"""hospital DICOM 네트워크(병원별 AET·IP·Port) — 40차

Revision ID: f5b6c7d8e9a0
Revises: e4b5c6d7f8a9
Create Date: 2026-06-14
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f5b6c7d8e9a0"
down_revision: Union[str, Sequence[str], None] = "e4b5c6d7f8a9"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("hospitals", sa.Column("server_host", sa.String(128), nullable=False, server_default=""))
    op.add_column("hospitals", sa.Column("scp_aet", sa.String(32), nullable=False, server_default=""))
    op.add_column("hospitals", sa.Column("scp_port", sa.Integer(), nullable=False, server_default="0"))
    op.add_column("hospitals", sa.Column("qr_aet", sa.String(32), nullable=False, server_default=""))
    op.add_column("hospitals", sa.Column("qr_port", sa.Integer(), nullable=False, server_default="0"))


def downgrade() -> None:
    for c in ("qr_port", "qr_aet", "scp_port", "scp_aet", "server_host"):
        op.drop_column("hospitals", c)
