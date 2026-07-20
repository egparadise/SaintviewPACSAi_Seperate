"""16차 — phrases 테이블 + orders 확장(body_part/projection/StudyID) + 판독 서명(accounts)

Revision ID: f6a7b8c9d0e1
Revises: e5f6a7b8c9d0
Create Date: 2026-06-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "f6a7b8c9d0e1"
down_revision: Union[str, Sequence[str], None] = "e5f6a7b8c9d0"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "phrases",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("name", sa.String(128), nullable=False),
        sa.Column("text", sa.Text(), nullable=False, server_default=""),
        sa.Column("modality", sa.String(16), nullable=False, server_default=""),
        sa.Column("body_part", sa.String(64), nullable=False, server_default=""),
        sa.Column("category", sa.String(64), nullable=False, server_default=""),
        sa.Column("shortcut", sa.String(8), nullable=False, server_default=""),
        sa.Column("created_by", sa.String(64), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_phrases_modality", "phrases", ["modality"])
    op.create_index("ix_phrases_body_part", "phrases", ["body_part"])

    op.add_column("orders", sa.Column("body_part", sa.String(64), nullable=False, server_default=""))
    op.add_column("orders", sa.Column("projection", sa.String(32), nullable=False, server_default=""))
    op.add_column("orders", sa.Column("dicom_study_id", sa.String(16), nullable=False, server_default=""))

    op.add_column("accounts", sa.Column("display_name", sa.String(64), nullable=False, server_default=""))
    op.add_column("accounts", sa.Column("license_no", sa.String(32), nullable=False, server_default=""))


def downgrade() -> None:
    op.drop_column("accounts", "license_no")
    op.drop_column("accounts", "display_name")
    op.drop_column("orders", "dicom_study_id")
    op.drop_column("orders", "projection")
    op.drop_column("orders", "body_part")
    op.drop_table("phrases")
