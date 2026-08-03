// UI 언어 — 설정>환경 최상단의 '언어' 선택이 이 모듈을 통해 전체 표기를 바꾼다.
//
// ■ 설계 (사용자 요구: 한글·영어·러시아어·중국어·일본어·스페인어·독일어·프랑스어·베트남어·아랍어)
//   · 문자열은 **키 하나 = 10개 언어 전부**로만 등록한다. 일부 언어만 채운 키는 테스트가
//     거부한다(tests/i18n_rule.test.mjs) — "영어만 되고 러시아어는 한국어가 나오는" 반쪽을 막는다.
//   · 미등록 키·미지원 언어는 **한국어로 폴백**한다 — 번역이 없다고 화면이 깨지면 안 된다.
//   · 아랍어는 RTL — 언어를 바꾸면 <html dir> 도 함께 바꾼다.
//   · 선택은 localStorage(즉시) + viewer.prefs.ui_lang(계정 로밍) 두 곳에 남는다.
//
// ■ 이관 방식
//   기존 화면의 한국어 리터럴을 한 번에 다 바꾸는 것은 불가능하다(수천 개, 의료 문구).
//   여기 키를 추가하고 호출부를 t("키") 로 바꾸는 **점진 이관**이 규칙이다.
//   이관 전 문자열은 언어와 무관하게 한국어로 남는다 — 그것이 폴백의 의미다.

import { useSyncExternalStore } from "react";

export type Lang = "ko" | "en" | "ru" | "zh" | "ja" | "es" | "de" | "fr" | "vi" | "ar";

export const LANGS: { code: Lang; native: string }[] = [
  { code: "ko", native: "한국어" },
  { code: "en", native: "English" },
  { code: "ru", native: "Русский" },
  { code: "zh", native: "中文" },
  { code: "ja", native: "日本語" },
  { code: "es", native: "Español" },
  { code: "de", native: "Deutsch" },
  { code: "fr", native: "Français" },
  { code: "vi", native: "Tiếng Việt" },
  { code: "ar", native: "العربية" },
];

export const ALL_LANGS: readonly Lang[] = LANGS.map((l) => l.code);

type Entry = Record<Lang, string>;

/** 번역 사전 — 키를 추가할 때는 **10개 언어를 전부** 채운다(테스트가 강제한다). */
export const MSG: Record<string, Entry> = {
  // ── 공통 버튼·동작 ──
  "language": { ko: "언어", en: "Language", ru: "Язык", zh: "语言", ja: "言語",
                es: "Idioma", de: "Sprache", fr: "Langue", vi: "Ngôn ngữ", ar: "اللغة" },
  "settings": { ko: "설정", en: "Settings", ru: "Настройки", zh: "设置", ja: "設定",
                es: "Ajustes", de: "Einstellungen", fr: "Paramètres", vi: "Cài đặt", ar: "الإعدادات" },
  "logout": { ko: "로그아웃", en: "Log out", ru: "Выход", zh: "退出登录", ja: "ログアウト",
              es: "Cerrar sesión", de: "Abmelden", fr: "Déconnexion", vi: "Đăng xuất", ar: "تسجيل الخروج" },
  "collab": { ko: "협진", en: "Co-Read", ru: "Консилиум", zh: "会诊", ja: "共同読影",
              es: "Colaboración", de: "Konsil", fr: "Concertation", vi: "Hội chẩn", ar: "استشارة" },
  "save": { ko: "저장", en: "Save", ru: "Сохранить", zh: "保存", ja: "保存",
            es: "Guardar", de: "Speichern", fr: "Enregistrer", vi: "Lưu", ar: "حفظ" },
  "okSave": { ko: "OK (저장)", en: "OK (Save)", ru: "OK (сохранить)", zh: "OK（保存）", ja: "OK（保存）",
              es: "OK (guardar)", de: "OK (speichern)", fr: "OK (enregistrer)", vi: "OK (lưu)", ar: "موافق (حفظ)" },
  "cancel": { ko: "취소", en: "Cancel", ru: "Отмена", zh: "取消", ja: "キャンセル",
              es: "Cancelar", de: "Abbrechen", fr: "Annuler", vi: "Hủy", ar: "إلغاء" },
  "close": { ko: "닫기", en: "Close", ru: "Закрыть", zh: "关闭", ja: "閉じる",
             es: "Cerrar", de: "Schließen", fr: "Fermer", vi: "Đóng", ar: "إغلاق" },
  "allClose": { ko: "전체 닫기", en: "All Close", ru: "Закрыть всё", zh: "全部关闭", ja: "すべて閉じる",
                es: "Cerrar todo", de: "Alle schließen", fr: "Tout fermer", vi: "Đóng tất cả", ar: "إغلاق الكل" },
  "reading": { ko: "판독", en: "Reading", ru: "Описание", zh: "阅片", ja: "読影",
               es: "Informe", de: "Befundung", fr: "Interprétation", vi: "Đọc phim", ar: "قراءة" },
  "manual": { ko: "수동", en: "Manual", ru: "Вручную", zh: "手动", ja: "手動",
              es: "Manual", de: "Manuell", fr: "Manuel", vi: "Thủ công", ar: "يدوي" },
  "auto": { ko: "자동", en: "Auto", ru: "Авто", zh: "自动", ja: "自動",
            es: "Auto", de: "Auto", fr: "Auto", vi: "Tự động", ar: "تلقائي" },
  "all": { ko: "전체", en: "All", ru: "Все", zh: "全部", ja: "すべて",
           es: "Todos", de: "Alle", fr: "Tous", vi: "Tất cả", ar: "الكل" },

  // ── 설정 좌측 내비 ──
  "nav.env": { ko: "환경 (Environment)", en: "Environment", ru: "Среда", zh: "环境", ja: "環境",
               es: "Entorno", de: "Umgebung", fr: "Environnement", vi: "Môi trường", ar: "البيئة" },
  "nav.worklist": { ko: "워크리스트", en: "Worklist", ru: "Рабочий список", zh: "工作列表", ja: "ワークリスト",
                    es: "Lista de trabajo", de: "Arbeitsliste", fr: "Liste de travail", vi: "Danh sách", ar: "قائمة العمل" },
  "nav.report": { ko: "리포트", en: "Report", ru: "Отчёт", zh: "报告", ja: "レポート",
                  es: "Informe", de: "Bericht", fr: "Rapport", vi: "Báo cáo", ar: "التقرير" },
  "nav.reading": { ko: "판독 (Reading)", en: "Reading", ru: "Описание", zh: "阅片", ja: "読影",
                   es: "Lectura", de: "Befundung", fr: "Interprétation", vi: "Đọc phim", ar: "القراءة" },
  "nav.viewerCommon": { ko: "뷰어 공통", en: "Viewer (Common)", ru: "Просмотрщик (общее)", zh: "查看器（通用）",
                        ja: "ビューア共通", es: "Visor (común)", de: "Viewer (gemeinsam)",
                        fr: "Visionneuse (commun)", vi: "Trình xem (chung)", ar: "العارض (مشترك)" },
  "nav.monitor": { ko: "모니터 (Display)", en: "Display", ru: "Мониторы", zh: "显示器", ja: "モニター",
                   es: "Pantallas", de: "Monitore", fr: "Écrans", vi: "Màn hình", ar: "الشاشات" },
  "nav.shortcuts": { ko: "단축키 (Mouse·Key)", en: "Shortcuts (Mouse·Key)", ru: "Горячие клавиши", zh: "快捷键",
                     ja: "ショートカット", es: "Atajos", de: "Kurzbefehle", fr: "Raccourcis",
                     vi: "Phím tắt", ar: "الاختصارات" },
  "nav.policy": { ko: "정책 (Policy)", en: "Policy", ru: "Политика", zh: "策略", ja: "ポリシー",
                  es: "Política", de: "Richtlinien", fr: "Politique", vi: "Chính sách", ar: "السياسة" },
  "nav.hp": { ko: "행잉 (HP)", en: "Hanging (HP)", ru: "Протоколы (HP)", zh: "挂片协议 (HP)", ja: "ハンギング (HP)",
              es: "Protocolos (HP)", de: "Hanging (HP)", fr: "Protocoles (HP)", vi: "Giao thức treo (HP)", ar: "بروتوكولات العرض" },
  "nav.speed": { ko: "속도 측정 (Speed Test)", en: "Speed Test", ru: "Тест скорости", zh: "速度测试",
                 ja: "速度測定", es: "Prueba de velocidad", de: "Geschwindigkeitstest",
                 fr: "Test de débit", vi: "Kiểm tra tốc độ", ar: "اختبار السرعة" },
  "nav.about": { ko: "정보 (About)", en: "About", ru: "О программе", zh: "关于", ja: "情報",
                 es: "Acerca de", de: "Info", fr: "À propos", vi: "Thông tin", ar: "حول" },

  // ── 환경 페이지 라벨 ──
  "env.listRefresh": { ko: "목록 갱신", en: "List refresh", ru: "Обновление списка", zh: "列表刷新",
                       ja: "リスト更新", es: "Actualización de lista", de: "Listenaktualisierung",
                       fr: "Rafraîchissement", vi: "Làm mới danh sách", ar: "تحديث القائمة" },
  "env.everySec": { ko: "초마다", en: "sec interval", ru: "сек интервал", zh: "秒间隔", ja: "秒ごと",
                    es: "cada seg", de: "Sek.-Intervall", fr: "s d'intervalle", vi: "giây/lần", ar: "كل ثانية" },
  "env.statusFilter": { ko: "기본 상태 필터", en: "Default status filter", ru: "Фильтр статуса", zh: "默认状态筛选",
                        ja: "既定ステータス", es: "Filtro de estado", de: "Status-Filter",
                        fr: "Filtre de statut", vi: "Bộ lọc trạng thái", ar: "مرشح الحالة" },
  "env.shortcutsRow": { ko: "단축키", en: "Shortcuts", ru: "Клавиши", zh: "快捷键", ja: "ショートカット",
                        es: "Atajos", de: "Kurzbefehle", fr: "Raccourcis", vi: "Phím tắt", ar: "اختصارات" },
  "env.dblClick": { ko: "더블클릭 동작", en: "Double-click action", ru: "Двойной клик", zh: "双击动作",
                    ja: "ダブルクリック動作", es: "Doble clic", de: "Doppelklick",
                    fr: "Double-clic", vi: "Nhấp đúp", ar: "النقر المزدوج" },
  "env.fetch": { ko: "영상 취득", en: "Image fetch", ru: "Получение изображений", zh: "影像获取",
                 ja: "画像取得", es: "Obtención de imágenes", de: "Bildabruf",
                 fr: "Acquisition d'images", vi: "Tải ảnh", ar: "جلب الصور" },
  "env.mode": { ko: "모드", en: "Mode", ru: "Режим", zh: "模式", ja: "モード",
                es: "Modo", de: "Modus", fr: "Mode", vi: "Chế độ", ar: "الوضع" },
  "env.storageCap": { ko: "저장 상한", en: "Storage cap", ru: "Лимит хранилища", zh: "存储上限",
                      ja: "保存上限", es: "Límite de almacenamiento", de: "Speicherlimit",
                      fr: "Plafond de stockage", vi: "Giới hạn lưu trữ", ar: "حد التخزين" },
  "env.autoDelete": { ko: "자동 삭제", en: "Auto delete", ru: "Автоудаление", zh: "自动删除",
                      ja: "自動削除", es: "Borrado automático", de: "Auto-Löschen",
                      fr: "Suppression auto", vi: "Tự xóa", ar: "حذف تلقائي" },
  "env.usage": { ko: "사용량", en: "Usage", ru: "Использовано", zh: "用量", ja: "使用量",
                 es: "Uso", de: "Belegung", fr: "Utilisation", vi: "Dung lượng dùng", ar: "الاستخدام" },
  "env.progress": { ko: "진행", en: "Progress", ru: "Прогресс", zh: "进度", ja: "進行",
                    es: "Progreso", de: "Fortschritt", fr: "Progression", vi: "Tiến trình", ar: "التقدّم" },
};

// ── 상태 ────────────────────────────────────────────────────────────────────
const LS_KEY = "sv_lang";

function normalize(v: unknown): Lang {
  return (ALL_LANGS as readonly string[]).includes(String(v)) ? (v as Lang) : "ko";
}

let cur: Lang = (() => {
  try { return normalize(localStorage.getItem(LS_KEY)); } catch { return "ko"; }
})();

const subs = new Set<() => void>();

/** 아랍어만 RTL — <html dir> 로 문서 전체 방향을 바꾼다. */
export function dirOf(l: Lang): "ltr" | "rtl" {
  return l === "ar" ? "rtl" : "ltr";
}

function applyDom(l: Lang): void {
  try {
    document.documentElement.lang = l;
    document.documentElement.dir = dirOf(l);
  } catch { /* SSR/테스트 환경 — DOM 없음 */ }
}
applyDom(cur);

// 뷰어·판독창은 **별도 브라우저 창**이다 — 설정 창에서 언어를 바꾸면 storage 이벤트로
// 같은 오리진의 다른 창에도 즉시 반영한다(구독 셋은 창마다 따로 있으므로 이 다리가 필요).
try {
  window.addEventListener("storage", (e) => {
    if (e.key !== LS_KEY || !e.newValue) return;
    const next = normalize(e.newValue);
    if (next === cur) return;
    cur = next;
    applyDom(next);
    subs.forEach((f) => { try { f(); } catch { /* 위와 동일 */ } });
  });
} catch { /* 테스트 환경 — window 없음 */ }

export function getLang(): Lang { return cur; }

export function setLang(l: Lang): void {
  const next = normalize(l);
  if (next === cur) return;
  cur = next;
  try { localStorage.setItem(LS_KEY, next); } catch { /* 시크릿 모드 등 — 무시 */ }
  applyDom(next);
  subs.forEach((f) => { try { f(); } catch { /* 구독자 하나가 나머지를 막지 않게 */ } });
}

/** 컴포넌트가 언어 변경에 반응하게 하는 훅 — t() 를 쓰는 컴포넌트는 이걸 함께 부른다. */
export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => { subs.add(cb); return () => subs.delete(cb); },
    () => cur,
  );
}

/** 번역 조회 — 미등록 키·빈 값은 **한국어로 폴백**(그마저 없으면 키 그대로). */
export function t(key: string, lang?: Lang): string {
  const e = MSG[key];
  if (!e) return key;
  return e[lang ?? cur] || e.ko || key;
}
