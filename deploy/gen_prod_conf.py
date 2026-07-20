"""prod nginx 설정 생성 — Orthanc 인증을 프록시에서 주입(브라우저에 자격증명 비노출).

사용: ORTHANC_PASSWORD=... python deploy/gen_prod_conf.py
생성: deploy/ohif/nginx-prod.conf (gitignore 대상 — 시크릿 포함)
"""
import base64
import os
import sys
from pathlib import Path

TEMPLATE = """# 자동 생성(gen_prod_conf.py) — 커밋 금지
server {{
    listen 80;
    server_name _;
    root /usr/share/nginx/html;
    index index.html;

    location /dicom-web/ {{
        proxy_pass http://orthanc:8042/dicom-web/;
        proxy_set_header Authorization "Basic {basic}";
        proxy_set_header Host $host;
        proxy_http_version 1.1;
        client_max_body_size 0;
    }}

    location / {{
        try_files $uri $uri/ /index.html;
    }}
}}
"""


def main() -> int:
    user = os.getenv("ORTHANC_USER", "saintview")
    password = os.getenv("ORTHANC_PASSWORD", "")
    if not password or password == "saintview_dev":
        print("오류: ORTHANC_PASSWORD 환경변수에 운영 비밀번호를 설정하세요(기본값 금지)")
        return 1
    basic = base64.b64encode(f"{user}:{password}".encode()).decode()
    out = Path(__file__).parent / "ohif" / "nginx-prod.conf"
    out.write_text(TEMPLATE.format(basic=basic), encoding="utf-8")
    print(f"생성: {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
