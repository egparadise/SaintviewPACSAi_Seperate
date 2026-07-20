"""add studies.key_images (F-16)

Revision ID: c1d2e3f4a5b6
Revises: bc8a938bfda7
Create Date: 2026-06-11
"""
from typing import Sequence, Union

import sqlalchemy as sa
from alembic import op

revision: str = "c1d2e3f4a5b6"
down_revision: Union[str, Sequence[str], None] = "bc8a938bfda7"
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.add_column("studies", sa.Column("key_images", sa.JSON(), nullable=True))
    op.execute("UPDATE studies SET key_images = '[]' WHERE key_images IS NULL")


def downgrade() -> None:
    op.drop_column("studies", "key_images")
