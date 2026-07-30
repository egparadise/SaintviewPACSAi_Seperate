// 프론트에서 나가는 요청의 **동시 발사 상한**과 **폴링 중복 방지**.
//
// 왜 필요한가 — 실제로 난 사고:
//   · 판독창을 한 번 열면 과거검사 전건에 대해 시리즈 트리·판독문을 **동시에** 쏘았다.
//     검사 하나가 A 왕복 여러 번이라 오픈 1회에 수십 건이 한꺼번에 나갔다.
//   · 판독 도크는 5초마다 상태를 물으면서 **직전 요청이 끝났는지 보지 않았다.**
//     A 가 5초보다 느려지면 요청이 겹쳐 쌓이고, 느려질수록 더 쌓이는 양의 되먹임이 된다.
//   백엔드는 핸들러 대부분이 sync 라 요청 하나가 스레드 하나를 쥔다. 그래서 프론트의
//   '한꺼번에' 가 곧바로 서버 스레드풀 고갈이 됐고, 로그인까지 굶었다.
//
// 서버에도 상한을 걸었지만(webpacs_live 의 세 게이트) **양쪽 다 필요하다** —
// 서버 상한은 넘친 요청을 거절할 뿐이고, 애초에 안 보내는 것이 사용자에게도 빠르다.

/** 동시 실행 수를 cap 으로 묶어 순서대로 처리한다. 결과 순서는 입력 순서와 같다. */
export async function limitedMap<T, R>(
  items: readonly T[],
  cap: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const n = items.length;
  const out = new Array<R>(n);
  if (!n) return out;
  const width = Math.max(1, Math.min(cap, n));
  let next = 0;
  const worker = async () => {
    for (;;) {
      const i = next++;
      if (i >= n) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}

/**
 * 폴링용 래퍼 — **직전 요청이 아직 안 끝났으면 이번 주기를 건너뛴다.**
 *
 * 실패가 이어지면 간격을 늘린다(지수 백오프). 서버가 아플 때 더 세게 때리지 않기 위해서다.
 * 성공하면 즉시 원래 간격으로 돌아온다.
 */
export interface PollHandle { stop: () => void }

export function pollWithGuard(
  fn: () => Promise<unknown>,
  everyMs: number,
  opts?: { maxBackoffMs?: number; immediate?: boolean },
): PollHandle {
  const maxBackoff = opts?.maxBackoffMs ?? Math.max(everyMs * 8, 30_000);
  let busy = false;
  let fails = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;

  const delay = () => (fails ? Math.min(everyMs * 2 ** fails, maxBackoff) : everyMs);

  const tick = async () => {
    if (stopped) return;
    if (busy) { schedule(); return; }        // ★ 겹치지 않게 — 이번 주기는 통째로 건너뛴다
    busy = true;
    try {
      await fn();
      fails = 0;
    } catch {
      fails = Math.min(fails + 1, 5);
    } finally {
      busy = false;
      schedule();
    }
  };

  function schedule() {
    if (stopped) return;
    timer = setTimeout(() => void tick(), delay());
  }

  if (opts?.immediate !== false) void tick();
  else schedule();

  return {
    stop: () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    },
  };
}

/**
 * 여러 컴포넌트가 **함께 쓰는** 동시 실행 상한.
 *
 * limitedMap 은 호출 한 번 안에서만 묶는다. 그런데 목록의 항목마다 컴포넌트가 마운트되어
 * 각자 요청을 쏘는 화면(판독창의 과거검사 썸네일)은 호출부가 N개라 묶을 방법이 없다.
 * 그런 곳은 모듈 수준 큐를 하나 두고 전부 그 줄에 세운다.
 */
export function sharedLimiter(cap: number) {
  const width = Math.max(1, cap);
  let live = 0;
  const queue: (() => void)[] = [];
  const next = () => {
    if (live >= width) return;
    const go = queue.shift();
    if (go) { live++; go(); }
  };
  return {
    run<R>(fn: () => Promise<R>): Promise<R> {
      return new Promise<R>((resolve, reject) => {
        queue.push(() => {
          fn().then(resolve, reject).finally(() => { live--; next(); });
        });
        next();
      });
    },
    get pending() { return queue.length; },
  };
}

/** 판독창 과거검사 썸네일 전용 — 항목이 20개여도 동시에 2건만 나간다. */
export const histThumbLimiter = sharedLimiter(2);
