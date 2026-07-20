"""add annotations(07 A.4) + orders(MWL/MPPS) tables — 13차

Revision ID: d3e4f5a6b7c8
Revises: c1d2e3f4a5b6
Create Date: 2026-06-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "d3e4f5a6b7c8"
down_revision: Union[str, Sequence[str], None] = "c1d2e3f4a5b6"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        "annotations",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("study_id", sa.Integer(), sa.ForeignKey("studies.id"), nullable=False),
        sa.Column("series_uid", sa.String(128), nullable=False, server_default=""),
        sa.Column("sop_uid", sa.String(128), nullable=False, server_default=""),
        sa.Column("kind", sa.String(32), nullable=False, server_default="line"),
        sa.Column("points", sa.JSON(), nullable=True),
        sa.Column("value", sa.Float(), nullable=True),
        sa.Column("unit", sa.String(16), nullable=False, server_default=""),
        sa.Column("text", sa.String(512), nullable=False, server_default=""),
        sa.Column("source", sa.String(16), nullable=False, server_default="user"),
        sa.Column("confidence", sa.Float(), nullable=True),
        sa.Column("verified", sa.Boolean(), nullable=False, server_default=sa.false()),
        sa.Column("created_by", sa.String(64), nullable=False, server_default=""),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_annotations_study_id", "annotations", ["study_id"])
    op.create_index("ix_annotations_sop_uid", "annotations", ["sop_uid"])

    op.create_table(
        "orders",
        sa.Column("id", sa.Integer(), primary_key=True),
        sa.Column("patient_key", sa.String(128), nullable=False),
        sa.Column("patient_name", sa.String(128), nullable=False, server_default=""),
        sa.Column("birth_date", sa.String(8), nullable=False, server_default=""),
        sa.Column("sex", sa.String(8), nullable=False, server_default=""),
        sa.Column("accession_no", sa.String(64), nullable=False, server_default=""),
        sa.Column("modality", sa.String(16), nullable=False, server_default=""),
        sa.Column("scheduled_date", sa.String(8), nullable=False, server_default=""),
        sa.Column("scheduled_time", sa.String(6), nullable=False, server_default=""),
        sa.Column("procedure_desc", sa.String(256), nullable=False, server_default=""),
        sa.Column("station_aet", sa.String(32), nullable=False, server_default=""),
        sa.Column("status", sa.String(16), nullable=False, server_default="scheduled"),
        sa.Column("created_at", sa.DateTime(timezone=True), nullable=True),
    )
    op.create_index("ix_orders_patient_key", "orders", ["patient_key"])
    op.create_index("ix_orders_accession_no", "orders", ["accession_no"])
    op.create_index("ix_orders_scheduled_date", "orders", ["scheduled_date"])
    op.create_index("ix_orders_status", "orders", ["status"])


def downgrade() -> None:
    op.drop_table("orders")
    op.drop_table("annotations")
