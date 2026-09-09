# Centras Echo — надёжные конференции, Google Drive и адаптивный UI: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Исправить жизненный цикл конференций и временных гостей, подключить надёжное сохранение записей в обычный Google Drive, гарантировать актуальные данные и привести весь интерфейс к быстрой адаптивной production-готовности.

**Architecture:** Fastify/PostgreSQL становятся единственным источником статуса встречи и типа сессии; frontend немедленно очищает гостя и обновляет server state без кэша. Записи сначала сохраняются локально, затем независимо отправляются в Google Drive через однократно подключённый OAuth обычного аккаунта. UI сохраняет Next.js/React/CSS Modules, разделяет крупную room page и загружает необязательные панели по требованию.

**Tech Stack:** Next.js 15, React 19, TypeScript, CSS Modules, Fastify 5, PostgreSQL, `@fastify/jwt`, LiveKit Server SDK, MediaRecorder, Gemini Files API, `googleapis`, Node `crypto` AES-256-GCM, Vitest, Testing Library, browser QA, Lighthouse/Core Web Vitals.

**Spec:** Архитектурная спецификация встроена в Part I этого файла; других plan/spec-файлов для этой работы нет.

## Global Constraints

- Не вводить Google Workspace, service account, новый global state framework или внешнюю очередь.
- Guest session действует только для одного `meetingId`, не открывает dashboard/archive/settings/admin и не выдаёт refresh token.
- `meetings.ended_at IS NOT NULL` запрещает новые join/token операции; повторный end идемпотентен.
- Завершение встречи не ждёт MediaRecorder, Gemini или Google Drive.
- OAuth/refresh/access tokens не попадают во frontend, query string, логи или API responses.
- Drive scope — только `https://www.googleapis.com/auth/drive.file`; OAuth app работает в Production mode.
- Stateful GET responses возвращают `Cache-Control: private, no-store, max-age=0`.
- Успех формы отображается только после успешного ответа API.
- Touch target — минимум 44×44 px; room controls доступны при 320×568; `prefers-reduced-motion` обязателен.
- Каждая Task выполняется red → green → refactor и заканчивается отдельной проверяемой поставкой.

---

## Порядок исполнения

- Phase 1 фиксирует общие session/meeting контракты и выполняется первой.
- Phase 2 и Phase 3 начинаются после Phase 1; общие файлы `app.ts`, `api.ts`, Settings интегрируются последовательно.
- Phase 4 начинается после функционального завершения Phases 1–3.
- Миграции сначала проверяются на test/preview БД, затем выполняются до выкладки API.
- Deployment order: обратно совместимый backend → frontend → LiveKit webhook → Drive OAuth.
- После каждой Task запускаются targeted tests; после каждой Phase — API tests, web tests и production build.

---

## Part I — Архитектурная техническая спецификация

## 1. Цель

Сделать состояние встречи и авторизации однозначным:

- завершённая встреча нигде не отображается как активная;
- анонимный участник публичной встречи получает временную сессию только для этой встречи;
- при выходе гостя браузерная сессия очищается сразу, а серверный временный пользователь удаляется идемпотентно;
- сбой записи или Google Drive не удерживает встречу в состоянии Live;
- список встреч обновляется после возврата на вкладку, восстановления сети и во время активной встречи;
- формы показывают только реально сохранённые данные;
- записи автоматически отправляются в один обычный Google Drive администратора после однократного OAuth-подключения.

## 2. Текущий стек и границы

- Frontend: Next.js 15 App Router, React 19, CSS Modules, LiveKit React Components.
- Backend: Fastify 5, TypeScript, PostgreSQL, `@fastify/jwt`, LiveKit Server SDK.
- Запись: клиентский `MediaRecorder`, загрузка до 50 МБ в API, локальный путь `/data/audio`.
- AI: Gemini Files API после приёма аудио.
- Google login: OAuth2 используется для входа, но Drive-соединения в текущей ветке нет.

Новые внешние платформы, очереди и Workspace не вводятся. Google Drive подключается к обычному Google-аккаунту администратора. Service account для Drive больше не используется.

## 3. Инварианты

1. `meetings.ended_at IS NOT NULL` означает, что новые join/token операции запрещены.
2. Повторный `POST /api/meetings/:id/end` безопасен и возвращает уже зафиксированный результат.
3. Финализация встречи не зависит от выгрузки записи, Gemini или Drive.
4. Guest access token содержит `sessionKind: "guest"` и `meetingId`; без совпадения `meetingId` гостевой запрос отклоняется.
5. Guest не получает доступ к dashboard, archive, settings, admin и данным других встреч.
6. Удаление временного пользователя каскадно отзывает refresh tokens и не удаляет встречу.
7. Успешное сообщение формы показывается только после успешного ответа API.
8. Секреты OAuth и refresh token никогда не попадают во frontend, URL, логи или ответы API.
9. Google Drive 401/403/429/5xx записываются в статус recording asset, но не меняют статус встречи обратно на active.
10. Все stateful GET-ответы авторизации и встреч имеют `Cache-Control: private, no-store`.

## 4. Модель состояния встречи

В `meetings` добавляются:

```sql
status TEXT NOT NULL DEFAULT 'scheduled'
  CHECK (status IN ('scheduled', 'active', 'ended')),
started_at TIMESTAMPTZ,
ended_reason TEXT
  CHECK (ended_reason IS NULL OR ended_reason IN ('host_ended', 'room_finished', 'stale_reconciled'))
```

Правила переходов:

```text
scheduled --первый LiveKit token--> active
active ----host end-------------> ended(host_ended)
active ----LiveKit room_finished> ended(room_finished)
active ----reconciliation-------> ended(stale_reconciled)
ended --------------------------> ended (идемпотентно)
```

`ended_at` остаётся совместимым публичным полем. Исторические строки мигрируются: `ended_at IS NULL` → `scheduled`, иначе `ended`.

`public-info` возвращает `status`, `startedAt`, `endedAt`. Для ended-встречи frontend показывает публичный экран «Конференция завершена» без формы гостевого входа.

## 5. Временная гостевая сессия

### Создание

`POST /api/auth/guest` принимает:

```json
{ "name": "Айжан", "meetingId": "uuid" }
```

Backend в одной транзакции проверяет:

- встреча существует;
- `is_public = true`;
- `status != 'ended'` и `ended_at IS NULL`;
- имя после trim имеет длину 1–60.

JWT claims:

```ts
type AuthClaims = {
  sub: string
  email: string
  name: string
  role: 'admin' | 'moderator' | 'employee'
  sessionKind: 'member' | 'guest'
  meetingId?: string
}
```

Guest access token живёт 2 часа, refresh token — 4 часа. Refresh сохраняет `sessionKind` и `meetingId` и повторно проверяет, что встреча не завершена.

### Выход

Клиентская операция `endGuestSession()`:

1. сохраняет текущий access token в локальную переменную;
2. синхронно удаляет access/refresh/cookie;
3. обновляет UI на публичный ended/left экран;
4. отправляет `POST /api/auth/logout` с сохранённым Bearer token и `keepalive: true`;
5. не восстанавливает сессию, если серверный logout временно недоступен.

Logout гостя удаляет временного пользователя и все связанные refresh tokens. Cleanup остаётся страховкой, но не основным механизмом.

## 6. Обычная Google-сессия

Текущий Google callback должен сохранять bcrypt-хеш выданного refresh token в `refresh_tokens`. Без этого access token перестаёт обновляться через 15 минут.

JWT обычного пользователя получает `sessionKind: "member"`. Refresh rotation атомарна: старый токен удаляется и новый записывается в одной транзакции. Logout удаляет все refresh tokens текущего пользователя только для существующего поведения «выйти со всех устройств»; отдельный endpoint одного устройства появится только при наличии реальной таблицы сессий.

## 7. Google Drive без Workspace

### Пользовательский сценарий

Администратор открывает Settings → Integrations → Google Drive и один раз нажимает «Подключить». Google показывает OAuth consent. После callback интерфейс показывает email подключённого аккаунта и папку `Centras Echo`. Повторный вход не нужен, пока пользователь не отозвал доступ.

OAuth параметры:

```text
scope=https://www.googleapis.com/auth/drive.file
access_type=offline
include_granted_scopes=true
prompt=consent   # только при первом подключении/переподключении
```

OAuth consent screen должен быть в Production. В режиме Testing refresh token внешнего приложения может истечь через семь дней.

### Конфигурация

```text
GOOGLE_DRIVE_CLIENT_ID
GOOGLE_DRIVE_CLIENT_SECRET
GOOGLE_DRIVE_REDIRECT_URI
TOKEN_ENCRYPTION_KEY        # 32 байта, base64
GOOGLE_DRIVE_FOLDER_NAME=Centras Echo
```

### Хранение подключения

```sql
CREATE TABLE google_drive_connections (
  user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  google_email TEXT NOT NULL,
  encrypted_refresh_token TEXT NOT NULL,
  folder_id TEXT,
  connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at TIMESTAMPTZ
);
```

Refresh token шифруется AES-256-GCM. В БД хранится строка `v1.<iv>.<tag>.<ciphertext>`. Ключ находится только в environment.

### Recording asset

```sql
CREATE TABLE recording_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  meeting_id UUID UNIQUE NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  local_path TEXT NOT NULL,
  mime_type TEXT NOT NULL,
  size_bytes BIGINT NOT NULL,
  upload_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (upload_status IN ('pending', 'uploading', 'ready', 'failed')),
  drive_file_id TEXT,
  drive_web_url TEXT,
  upload_attempts INT NOT NULL DEFAULT 0,
  last_error_code TEXT,
  last_error_message TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`AudioStorage` отделяет API встречи от провайдера:

```ts
export interface AudioStorage {
  upload(input: {
    localPath: string
    fileName: string
    mimeType: string
  }): Promise<{ providerId: string; webUrl: string }>
}
```

Реализация использует официальный `googleapis` SDK и обычный пользовательский refresh token. Папка `Centras Echo` ищется или создаётся один раз; `folder_id` сохраняется в подключении.

### Ошибки и повтор

- `invalid_grant`: connection помечается revoked, UI просит переподключить Drive.
- 403 quota: asset → failed с понятным сообщением «На Google Диске закончилось место».
- 429/5xx/network: до трёх попыток с задержками 5/30/120 секунд.
- Ручной retry доступен администратору и создателю встречи.
- Никакая Drive-ошибка не откатывает `meetings.status`.

## 8. Порядок завершения и записи

Кнопка host «Завершить для всех» выполняет:

1. немедленно блокирует повторный клик;
2. вызывает идемпотентный `/end` и фиксирует `ended_at`;
3. останавливает LiveKit room;
4. останавливает локальный `MediaRecorder`;
5. показывает экран «Встреча завершена, сохраняем запись»;
6. загружает полученный файл в API с прогрессом/ошибкой;
7. после приёма API независимо запускает Gemini и Google Drive;
8. переход на dashboard не меняет уже завершённый статус.

Если network upload не удался, пользователю предлагается повтор и скачать локальную копию. Встреча остаётся ended.

## 9. Актуальность данных

Без новой state-management библиотеки создаётся небольшой `useMeetingsData`:

- fetch при mount;
- refetch на `window.focus`, `online`, `visibilitychange` → visible;
- polling каждые 5 секунд только когда есть active-встречи и вкладка видима;
- AbortController отменяет устаревший запрос;
- после create/end ответ API сразу обновляет локальное состояние;
- ошибки не затирают последнюю успешную выдачу.

API сначала выполняет синхронную reconciliation активных встреч, затем отвечает. Старое правило «через два часа поставить duration=1800» удаляется.

## 10. Формы и окна

### Dashboard

- title: trim, 1–200, ошибка возле поля;
- datetime-local: корректный `min`, запрет времени в прошлом;
- create error показывается в modal, а не теряется;
- modal закрывается Escape, возвращает focus на кнопку создания;
- во время submit кнопки и закрытие блокируются.

### Guest join

- ended-встреча не показывает форму;
- name: 1–60, серверная ошибка отображается рядом;
- guest session создаётся только с `meetingId`;
- переход «назад» завершает временную сессию.

### Settings

- `PATCH /api/auth/profile` реально сохраняет имя;
- password-раздел скрыт для Google-only аккаунтов;
- fake notifications и fake session rows удаляются до появления backend-модели;
- logout button говорит «Выйти», а не «со всех устройств», если endpoint завершает только текущий сценарий;
- Google Drive section показывает disconnected/connecting/connected/reconnect-required.

### Room и Archive

- `alert()` заменяется inline status/toast с конкретным следующим действием;
- upload и export имеют progress/disabled/error состояния;
- повторная отправка не создаёт второй recording asset;
- destructive modal имеет один визуально главный destructive action.

## 11. UI и производительность

- Проверяем 375×812, 768×1024, 1280×800 и 1440×900.
- Нет горизонтального scroll; touch targets не меньше 44×44.
- Focus ring видим; modal удерживает focus и закрывается Escape.
- `prefers-reduced-motion` отключает необязательные анимации.
- `room/[id]/page.tsx` делится по ответственности: session bootstrap, prejoin, room shell, recording controller, secondary panels.
- Chat/Senti/Translate панели загружаются динамически и не участвуют в первом room bundle до открытия.
- Polling при hidden-вкладке остановлен.
- Цель: room route уменьшить с текущих 170 кБ минимум на 15% без удаления функций.

## 12. API-контракты

Новые/изменённые endpoints:

```text
POST   /api/auth/guest                         {name, meetingId}
POST   /api/auth/logout                        idempotent guest/member logout
PATCH  /api/auth/profile                       {name}
GET    /api/meetings/:id/public-info           +status,+startedAt,+endedAt
POST   /api/meetings/:id/end                   idempotent result
POST   /api/livekit/webhook                    LiveKit signed events
GET    /api/integrations/google-drive/status
POST   /api/integrations/google-drive/connect  returns {authorizationUrl}
GET    /api/integrations/google-drive/callback
DELETE /api/integrations/google-drive
GET    /api/meetings/:id/recording
POST   /api/meetings/:id/recording/retry
```

Все ошибки сохраняют форму:

```json
{ "error": { "code": "MACHINE_CODE", "message": "Понятное действие для пользователя" } }
```

## 13. Проверки готовности

1. Открыть ended public link без токенов: форма имени отсутствует.
2. Войти гостем, выйти: токены исчезают синхронно; `/dashboard` переводит на login; user отсутствует в БД.
3. Завершить встречу при искусственной Drive 403: dashboard показывает её в архиве сразу.
4. Оставить dashboard открытым и завершить встречу во второй вкладке: карточка переезжает в прошлые ≤5 секунд.
5. Google Drive подключается один раз и работает после перезапуска API без повторного входа.
6. `invalid_grant` показывает «Переподключить», не бесконечный spinner.
7. Fake success в Settings отсутствуют.
8. Production build, API unit/integration tests и frontend interaction tests зелёные.
9. На четырёх viewport нет horizontal overflow, clipped modal и touch targets меньше 44 px.
10. Security/adversarial review не находит способа гостю читать другую встречу или вывести refresh token.

## 14. Порядок поставки

1. Auth и meeting lifecycle.
2. Google Drive recording storage.
3. Data freshness и реальные формы.
4. Responsive/UI, browser verification и финальный security review.

Каждый этап должен быть deployable отдельно. Этап 1 не зависит от готовности Google Drive.

---

## Part II — Единый план реализации

## Phase 1 — Временный гость и жизненный цикл конференции

### Карта файлов

**Создать:**

- `apps/api/src/app.ts` — тестируемая фабрика Fastify.
- `apps/api/src/auth/session-claims.ts` — типы claims и guard-функции.
- `apps/api/src/services/meeting-lifecycle.ts` — переходы `scheduled → active → ended`.
- `apps/api/src/routes/livekit-webhooks.ts` — подтверждённые webhook-события LiveKit.
- `apps/api/src/test/app.test.ts`
- `apps/api/src/auth/session-claims.test.ts`
- `apps/api/src/services/meeting-lifecycle.test.ts`
- `apps/web/src/lib/guest-session.ts`
- `apps/web/src/lib/guest-session.test.ts`
- `apps/web/vitest.config.ts`
- `apps/api/vitest.config.ts`

**Изменить:**

- `apps/api/src/index.ts`
- `apps/api/src/db/schema.sql`
- `apps/api/src/routes/auth.ts`
- `apps/api/src/routes/google-auth.ts`
- `apps/api/src/routes/meetings.ts`
- `apps/api/src/routes/livekit.ts`
- `apps/web/src/lib/api.ts`
- `apps/web/src/middleware.ts`
- `apps/web/src/app/room/[id]/page.tsx`
- `apps/web/src/app/room/[id]/room.module.css`
- `apps/web/src/app/auth/callback/page.tsx`
- `apps/api/package.json`, `apps/web/package.json`, `pnpm-lock.yaml`

### Task 1.1: Добавить тестовую опору без изменения поведения

**Files:** `apps/api/src/app.ts`, `apps/api/src/index.ts`, `apps/api/vitest.config.ts`, `apps/api/src/test/app.test.ts`, `apps/api/package.json`, `apps/web/vitest.config.ts`, `apps/web/package.json`, `pnpm-lock.yaml`

**Interfaces:**

- Consumes: текущий `apps/api/src/index.ts` и регистрацию маршрутов.
- Produces: `buildApp(options): Promise<FastifyInstance>`, API/web Vitest-конфигурацию и scripts `test`.

- [ ] **Step 1:** Установить зависимости:

   ```powershell
   pnpm --filter api add -D vitest
   pnpm --filter web add -D vitest jsdom @testing-library/react @testing-library/user-event
   ```

- [ ] **Step 2:** Написать падающий smoke-тест фабрики:

   ```ts
   import { describe, expect, it } from "vitest";
   import { buildApp } from "../app";

   describe("buildApp", () => {
     it("returns a ready Fastify app without opening a port", async () => {
       const app = await buildApp({ logger: false });
       await app.ready();
       expect(app.hasRoute({ method: "GET", url: "/health" })).toBe(true);
       await app.close();
     });
   });
   ```

- [ ] **Step 3:** Запустить `pnpm --filter api exec vitest run src/test/app.test.ts`; ожидается FAIL: модуль `../app` отсутствует.
- [ ] **Step 4:** Перенести создание приложения и регистрацию плагинов/маршрутов из `index.ts` в `buildApp()`. В `index.ts` оставить чтение окружения, `await buildApp()` и `listen()`.
- [ ] **Step 5:** Добавить scripts `test` и `test:watch` в оба package.json.
- [ ] **Step 6:** Запустить `pnpm --filter api test`; ожидается PASS. Затем `pnpm build`; ожидается успешная сборка всех workspace-пакетов.
- [ ] **Step 7:** Commit: `test: add api and web test foundations`

### Task 1.2: Зафиксировать модель статуса встречи в БД

**Files:** `apps/api/src/db/schema.sql`, `apps/api/src/services/meeting-lifecycle.test.ts`, `apps/api/src/services/meeting-lifecycle.ts`

**Interfaces:**

- Consumes: `buildApp`, PostgreSQL pool и таблицу `meetings`.
- Produces: `nextMeetingState()`, `activateMeeting()`, `endMeeting()`.

- [ ] **Step 1:** Написать тесты чистой функции переходов:

   ```ts
   expect(nextMeetingState("scheduled", "token_issued")).toEqual({ status: "active" });
   expect(nextMeetingState("active", "host_ended")).toEqual({ status: "ended", endedReason: "host_ended" });
   expect(nextMeetingState("ended", "host_ended")).toEqual({ status: "ended" });
   expect(() => nextMeetingState("ended", "token_issued")).toThrow("MEETING_ENDED");
   ```

- [ ] **Step 2:** Запустить тест; ожидается FAIL: функция отсутствует.
- [ ] **Step 3:** Добавить в `schema.sql` идемпотентные `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` для:

   ```sql
   status TEXT NOT NULL DEFAULT 'scheduled',
   started_at TIMESTAMPTZ,
   ended_reason TEXT
   ```

   Добавить check constraints через блок `DO $$ ... $$`; выполнить backfill: `ended_at IS NOT NULL → ended`, остальные строки → `scheduled`.
- [ ] **Step 4:** Реализовать `MeetingStatus`, `MeetingEvent`, `nextMeetingState()` и транзакционные функции `activateMeeting()`/`endMeeting()` с `SELECT ... FOR UPDATE`. `endMeeting()` должен возвращать текущий ended-результат при повторе.
- [ ] **Step 5:** Запустить `pnpm --filter api test`; ожидается PASS.
- [ ] **Step 6:** На тестовой БД выполнить `pnpm db:migrate`, затем SQL-проверку распределения статусов и отсутствия NULL.
- [ ] **Step 7:** Commit: `feat: add authoritative meeting lifecycle`

### Task 1.3: Сделать claims явными и исправить Google SSO refresh

**Files:** `apps/api/src/auth/session-claims.ts`, `apps/api/src/auth/session-claims.test.ts`, `apps/api/src/routes/auth.ts`, `apps/api/src/routes/google-auth.ts`, `apps/web/src/app/auth/callback/page.tsx`

**Interfaces:**

- Consumes: JWT plugin и refresh-token repository.
- Produces: `SessionClaims`, `requireMember()`, `requireMeetingAccess()` и централизованную выдачу tokens.

- [ ] **Step 1:** Написать тесты guards:

   ```ts
   const guest = { sub: "g1", sessionKind: "guest", meetingId: "m1", role: "guest" };
   expect(requireMember(guest)).toThrow("MEMBER_SESSION_REQUIRED");
   expect(requireMeetingAccess(guest, "m1")).toBeUndefined();
   expect(() => requireMeetingAccess(guest, "m2")).toThrow("MEETING_SCOPE_MISMATCH");
   ```

- [ ] **Step 2:** Запустить тест; ожидается FAIL.
- [ ] **Step 3:** Реализовать discriminated union:

   ```ts
   type SessionClaims =
     | { sub: string; role: string; sessionKind: "member" }
     | { sub: string; role: "guest"; sessionKind: "guest"; meetingId: string };
   ```

- [ ] **Step 4:** Централизовать выдачу токенов. Member access TTL оставить текущим; guest access TTL установить `30m`, guest refresh не выдавать.
- [ ] **Step 5:** В Google callback сохранять SHA-256 hash refresh token в существующую таблицу refresh tokens в той же транзакции, что и выдача. В URL callback передавать только одноразовый code либо токены через безопасный fragment, никогда не query string; предпочтительно обмен `POST /api/auth/exchange`.
- [ ] **Step 6:** Добавить тест: refresh token после Google SSO принимается `/api/auth/refresh`, а повтор после logout отклоняется.
- [ ] **Step 7:** Запустить `pnpm --filter api test`; ожидается PASS.
- [ ] **Step 8:** Commit: `fix: enforce typed sessions and persist google refresh tokens`

### Task 1.4: Ограничить создание и права гостя одной встречей

**Files:** `apps/api/src/routes/auth.ts`, `apps/api/src/routes/meetings.ts`, `apps/api/src/routes/livekit.ts`, `apps/api/src/auth/session-claims.test.ts`

**Interfaces:**

- Consumes: guards и lifecycle Tasks 1.2–1.3.
- Produces: `POST /api/auth/guest { name, meetingId }` и meeting-scoped access.

- [ ] **Step 1:** Добавить route-тесты для `POST /api/auth/guest`:

   - без `meetingId` → 400;
   - несуществующая встреча → 404;
   - ended-встреча → 410 `MEETING_ENDED`;
   - непубличная встреча → 403;
   - active/scheduled public-встреча → 201 и guest claims с нужным `meetingId`.

- [ ] **Step 2:** Запустить тесты; ожидается FAIL на текущем контракте `{ name }`.
- [ ] **Step 3:** Изменить входной контракт на `{ name, meetingId }`; нормализовать имя, длина 2–80, запретить control characters. Создание user/session выполнять транзакционно после проверки встречи.
- [ ] **Step 4:** Применить `requireMember()` к dashboard/archive/settings/admin endpoints и `requireMeetingAccess()` к join/token/public participant endpoints.
- [ ] **Step 5:** В выдаче первого LiveKit token атомарно вызвать `activateMeeting()`; для ended вернуть 410 без токена.
- [ ] **Step 6:** Запустить route-тесты и `pnpm --filter api test`; ожидается PASS.
- [ ] **Step 7:** Commit: `fix: scope public guests to one meeting`

### Task 1.5: Гарантировать немедленный logout гостя на клиенте

**Files:** `apps/web/src/lib/guest-session.ts`, `apps/web/src/lib/guest-session.test.ts`, `apps/web/src/lib/api.ts`, `apps/web/src/app/room/[id]/page.tsx`, `apps/web/src/middleware.ts`

**Interfaces:**

- Consumes: guest claims и backend logout.
- Produces: `isGuestSession()`, `clearGuestSession()`, `logoutGuest()` и единый `leaveRoom()`.

- [ ] **Step 1:** Написать jsdom-тест:

   ```ts
   localStorage.setItem("accessToken", "guest-token");
   localStorage.setItem("sessionKind", "guest");
   clearGuestSession();
   expect(localStorage.getItem("accessToken")).toBeNull();
   expect(localStorage.getItem("sessionKind")).toBeNull();
   ```

   И тест, что member-токен функция не удаляет.
- [ ] **Step 2:** Запустить `pnpm --filter web test`; ожидается FAIL.
- [ ] **Step 3:** Реализовать `isGuestSession()`, `clearGuestSession()` и `logoutGuest({ reason })`. Порядок строго такой:

   ```ts
   const token = readAccessToken();
   clearGuestSession();
   navigator.sendBeacon?.("/api/auth/logout", payload) ||
     void fetch("/api/auth/logout", { method: "POST", headers, keepalive: true });
   ```

   Если API расположен на другом origin, использовать `fetch(..., { keepalive: true })`; токен передать в Authorization header, не в body/URL.
- [ ] **Step 4:** Вызывать единый `leaveRoom()` из кнопки выхода, LiveKit `onDisconnected`, `pagehide`, ended-event, ожидания/ошибки входа и route cleanup. Переход гостя — на `/` или публичный экран завершения; никогда на `/dashboard`.
- [ ] **Step 5:** Backend logout сделать идемпотентным: revoke tokens → удалить только `users.is_guest = true` → 204 даже при повторе.
- [ ] **Step 6:** Middleware и layout-guards должны редиректить `sessionKind=guest` с `/dashboard`, `/archive`, `/settings`, `/admin` на `/`.
- [ ] **Step 7:** Запустить unit и route-тесты; ожидается PASS.
- [ ] **Step 8:** Commit: `fix: terminate temporary guest sessions on every exit path`

### Task 1.6: Завершать встречу независимо от записи и Drive

**Files:** `apps/api/src/routes/meetings.ts`, `apps/api/src/services/meeting-lifecycle.ts`, `apps/web/src/app/room/[id]/page.tsx`

**Interfaces:**

- Consumes: `endMeeting()` и host end route.
- Produces: идемпотентный неблокирующий `POST /api/meetings/:id/end`.

- [ ] **Step 1:** Написать route-тесты: host end отвечает 200 менее чем за 1 секунду при зависшем mock upload; повторный end возвращает тот же `endedAt`; не-host получает 403.
- [ ] **Step 2:** Запустить; ожидается FAIL: текущий flow связан с клиентской остановкой/выгрузкой.
- [ ] **Step 3:** В `POST /api/meetings/:id/end` сначала транзакционно фиксировать `status='ended'`, `ended_at=NOW()`, `ended_reason='host_ended'`; после commit публиковать событие/закрывать LiveKit room best-effort.
- [ ] **Step 4:** На клиенте host flow: запрос end → немедленно показать ended UI и отключить участников → отдельно завершить recorder/upload. Ошибка upload не откатывает UI и статус.
- [ ] **Step 5:** Удалить эвристику `created_at + 30 minutes`. Reconciliation может завершать только `active` встречи при доказанном отсутствии комнаты и писать `stale_reconciled` с фактическим временем reconciliation.
- [ ] **Step 6:** Запустить тесты; ожидается PASS.
- [ ] **Step 7:** Commit: `fix: decouple meeting finalization from recording upload`

### Task 1.7: Подключить подписанный LiveKit webhook

**Files:** `apps/api/src/routes/livekit-webhooks.ts`, `apps/api/src/app.ts`, `apps/api/src/services/meeting-lifecycle.test.ts`, `apps/api/package.json`, `pnpm-lock.yaml`

**Interfaces:**

- Consumes: `endMeeting()` и LiveKit verifier.
- Produces: подписанный `POST /api/livekit/webhooks`.

- [ ] **Step 1:** Добавить тесты: неверная подпись → 401 и без изменения БД; повторный `room_finished` → 200 и одно ended-состояние; неизвестная комната → 202 no-op.
- [ ] **Step 2:** Запустить; ожидается FAIL.
- [ ] **Step 3:** Добавить raw body поддержку совместимым Fastify-плагином и проверить webhook через официальный LiveKit verifier. Не принимать JSON до проверки подписи.
- [ ] **Step 4:** Маппить имя комнаты на meeting ID и вызывать `endMeeting(..., "room_finished")`.
- [ ] **Step 5:** Запустить тесты; ожидается PASS.
- [ ] **Step 6:** Commit: `feat: reconcile meeting status from livekit webhooks`

### Task 1.8: Не показывать форму входа для завершённой публичной встречи

**Files:** `apps/api/src/routes/meetings.ts`, `apps/web/src/app/room/[id]/page.tsx`, `apps/web/src/app/room/[id]/room.module.css`

**Interfaces:**

- Consumes: authoritative status и public-info route.
- Produces: расширенный public-info contract и терминальный ended UI.

- [ ] **Step 1:** Добавить route-тест, что `GET /api/meetings/:id/public-info` возвращает `status`, `startedAt`, `endedAt` и `Cache-Control: private, no-store`.
- [ ] **Step 2:** Добавить component-тест: `status="ended"` показывает «Конференция завершена», не рендерит поле имени и кнопку входа.
- [ ] **Step 3:** Реализовать контракт и экран. Для 410 во время submit переключать UI в ended-state и очищать гостевую сессию.
- [ ] **Step 4:** Проверить сценарии: новый guest join; guest leave; refresh после leave; host end при подключённом guest; повторное открытие ended public link.
- [ ] **Step 5:** Запустить:

   ```powershell
   pnpm --filter api test
   pnpm --filter web test
   pnpm build
   ```

   Ожидается: все тесты и сборка PASS.
- [ ] **Step 6:** Commit: `fix: render authoritative ended state on public links`

### Приёмка Phase 1

- Гость после клика «Выйти» мгновенно не имеет локальных токенов и не видит профиль.
- Серверный guest user и его токены удаляются идемпотентно; member user не затрагивается.
- Ended public link никогда не создаёт гостя и не выдаёт LiveKit token.
- Host end не блокируется MediaRecorder, Gemini или Google Drive.
- LiveKit webhook и повторный end не создают расхождений статуса.
- API/session тесты, web-тесты и monorepo build проходят.

---

## Phase 2 — Google Drive через один обычный аккаунт

### Карта файлов

**Создать:**

- `apps/api/src/config/drive.ts`
- `apps/api/src/security/token-cipher.ts`
- `apps/api/src/security/token-cipher.test.ts`
- `apps/api/src/services/audio-storage.ts`
- `apps/api/src/services/google-drive-storage.ts`
- `apps/api/src/services/google-drive-storage.test.ts`
- `apps/api/src/services/recording-assets.ts`
- `apps/api/src/services/recording-assets.test.ts`
- `apps/api/src/routes/google-drive.ts`
- `apps/api/src/routes/google-drive.test.ts`
- `apps/web/src/components/DriveConnectionCard.tsx`
- `apps/web/src/components/DriveConnectionCard.test.tsx`

**Изменить:**

- `apps/api/src/db/schema.sql`
- `apps/api/src/app.ts`
- `apps/api/src/routes/meetings.ts`
- `apps/api/src/services/gemini.ts`
- `apps/api/package.json`, `pnpm-lock.yaml`
- `apps/web/src/app/settings/page.tsx`
- `apps/web/src/app/settings/settings.module.css`
- `.env.example`

### Task 2.1: Ввести строгую конфигурацию Drive

**Files:** `apps/api/src/config/drive.ts`, `.env.example`, `apps/api/src/config/drive.test.ts`

**Interfaces:**

- Consumes: текущее env-loading API.
- Produces: `DriveConfig` и `loadDriveConfig()`.

- [ ] **Step 1:** Написать тесты: полная конфигурация парсится; отсутствующий `DRIVE_OAUTH_CLIENT_ID` отключает интеграцию в status endpoint; неверный `TOKEN_ENCRYPTION_KEY` отклоняется при startup с понятным сообщением.
- [ ] **Step 2:** Запустить `pnpm --filter api exec vitest run src/config/drive.test.ts`; ожидается FAIL.
- [ ] **Step 3:** Реализовать конфигурацию:

   ```text
   DRIVE_OAUTH_CLIENT_ID=
   DRIVE_OAUTH_CLIENT_SECRET=
   DRIVE_OAUTH_REDIRECT_URI=https://<api-host>/api/integrations/google-drive/callback
   DRIVE_FOLDER_NAME=Centras Echo Recordings
   TOKEN_ENCRYPTION_KEY=<base64-encoded 32 bytes>
   ```

- [ ] **Step 4:** Не поддерживать `GOOGLE_SERVICE_ACCOUNT_*` в новом adapter. Если старые переменные обнаружены без OAuth-конфигурации, status должен вернуть `configurationMode: "unsupported_service_account"` и инструкцию переподключить обычный аккаунт.
- [ ] **Step 5:** Запустить тест; ожидается PASS.
- [ ] **Step 6:** Commit: `feat: add validated google drive oauth configuration`

### Task 2.2: Создать схему соединения и артефактов записи

**Files:** `apps/api/src/db/schema.sql`, `apps/api/src/services/recording-assets.test.ts`

**Interfaces:**

- Consumes: PostgreSQL schema и meeting IDs.
- Produces: `google_drive_connections`, `recording_assets` и compare-and-set repository.

- [ ] **Step 1:** Написать DB/service-тесты переходов `local → uploading → uploaded` и `uploading → failed`, включая идемпотентность по `meeting_id + sha256`.
- [ ] **Step 2:** Добавить таблицу единственного активного соединения:

   ```sql
   CREATE TABLE IF NOT EXISTS google_drive_connections (
     id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
     google_account_email TEXT NOT NULL,
     refresh_token_ciphertext TEXT NOT NULL,
     refresh_token_iv TEXT NOT NULL,
     refresh_token_tag TEXT NOT NULL,
     scope TEXT NOT NULL,
     folder_id TEXT,
     connected_by UUID NOT NULL REFERENCES users(id),
     connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
     revoked_at TIMESTAMPTZ
   );
   ```

- [ ] **Step 3:** Добавить `recording_assets` с `meeting_id`, `local_path`, `mime_type`, `bytes`, `sha256`, `storage_status` (`local|uploading|uploaded|failed`), `drive_file_id`, `drive_web_view_link`, `attempt_count`, `last_error_code`, `last_error_message`, timestamps. Уникальность: `(meeting_id, sha256)`.
- [ ] **Step 4:** Реализовать repository-функции compare-and-set для статусов; секретные значения не выбирать в status/list endpoints.
- [ ] **Step 5:** Выполнить `pnpm db:migrate` на тестовой БД и тесты; ожидается PASS.
- [ ] **Step 6:** Commit: `feat: persist drive connection and recording upload state`

### Task 2.3: Шифровать refresh token перед сохранением

**Files:** `apps/api/src/security/token-cipher.ts`, `apps/api/src/security/token-cipher.test.ts`

**Interfaces:**

- Consumes: `TOKEN_ENCRYPTION_KEY`.
- Produces: `encryptToken()`, `decryptToken()` и `CipherEnvelope`.

- [ ] **Step 1:** Написать тесты round trip, различный IV для одинакового plaintext, отклонение изменённого auth tag и неверного ключа.
- [ ] **Step 2:** Запустить тест; ожидается FAIL.
- [ ] **Step 3:** Реализовать AES-256-GCM:

   ```ts
   type CipherEnvelope = { ciphertext: string; iv: string; tag: string };
   encryptToken(token: string, key: Buffer): CipherEnvelope;
   decryptToken(envelope: CipherEnvelope, key: Buffer): string;
   ```

   Все поля кодировать base64url; IV генерировать `randomBytes(12)`; ключ ровно 32 bytes.
- [ ] **Step 4:** Запустить тест; ожидается PASS. Проверить, что ни один logger-call не содержит token/envelope plaintext.
- [ ] **Step 5:** Commit: `feat: encrypt google oauth refresh tokens at rest`

### Task 2.4: Реализовать одноразовое OAuth-подключение администратора

**Files:** `apps/api/src/routes/google-drive.ts`, `apps/api/src/routes/google-drive.test.ts`, `apps/api/src/app.ts`

**Interfaces:**

- Consumes: DriveConfig, cipher и admin guard.
- Produces: OAuth status/connect/callback/disconnect endpoints.

- [ ] **Step 1:** Написать route-тесты:

   - member не-admin → 403;
   - `GET /connect` создаёт state, scope `drive.file`, `access_type=offline`, `prompt=consent` только при первичном подключении;
   - callback с неверным/повторным state → 400;
   - callback без refresh token при отсутствии сохранённого соединения → управляемая ошибка;
   - callback сохраняет только encrypted envelope и email;
   - disconnect помечает `revoked_at`, очищает локальный token и best-effort отзывает его у Google.

- [ ] **Step 2:** Запустить; ожидается FAIL.
- [ ] **Step 3:** Установить `googleapis` и реализовать endpoints:

   ```text
   GET  /api/integrations/google-drive/status
   GET  /api/integrations/google-drive/connect
   GET  /api/integrations/google-drive/callback
   POST /api/integrations/google-drive/disconnect
   ```

- [ ] **Step 4:** State хранить server-side либо в короткоживущем подписанном HttpOnly SameSite=Lax cookie с nonce и admin user ID; TTL 10 минут; после callback одноразово удалить.
- [ ] **Step 5:** OAuth client использовать `access_type=offline`, scope `https://www.googleapis.com/auth/drive.file`. Google consent screen перевести в Production, чтобы refresh token не истекал из-за режима Testing.
- [ ] **Step 6:** Callback завершать редиректом `/settings?drive=connected`, не передавать токены.
- [ ] **Step 7:** Запустить route-тесты; ожидается PASS.
- [ ] **Step 8:** Commit: `feat: connect one personal google drive with oauth`

### Task 2.5: Реализовать adapter загрузки и папку

**Files:** `apps/api/src/services/audio-storage.ts`, `apps/api/src/services/google-drive-storage.ts`, `apps/api/src/services/google-drive-storage.test.ts`

**Interfaces:**

- Consumes: OAuth connection и `googleapis`.
- Produces: `AudioStorage` и `GoogleDriveStorage.upload()`.

- [ ] **Step 1:** Зафиксировать интерфейс:

   ```ts
   interface AudioStorage {
     upload(input: {
       path: string;
       fileName: string;
       mimeType: string;
       meetingId: string;
     }): Promise<{ provider: "google-drive"; fileId: string; webViewLink?: string }>;
   }
   ```

- [ ] **Step 2:** Написать тесты через mocked Drive API: reuse существующей папки; create одной папки; upload с `supportsAllDrives: false`; duplicate retry не создаёт второй файл; 401, 403 quota, 429, 5xx классифицируются.
- [ ] **Step 3:** Запустить; ожидается FAIL.
- [ ] **Step 4:** Реализовать refresh access token через сохранённый refresh token, поиск папки по exact name + `trashed=false`, сохранение `folder_id`, загрузку stream-ом без чтения всего файла в RAM.
- [ ] **Step 5:** Имя файла формировать безопасно и стабильно: `<YYYY-MM-DD>_<sanitized-title>_<meeting-id>.webm`; Google file `appProperties` содержит `meetingId` и `sha256` для идемпотентного поиска.
- [ ] **Step 6:** Ошибки свести к кодам:

   ```text
   DRIVE_REAUTH_REQUIRED       401 / invalid_grant
   DRIVE_QUOTA_UNAVAILABLE     403 storageQuotaExceeded
   DRIVE_PERMISSION_DENIED     другие 403
   DRIVE_RATE_LIMITED          429
   DRIVE_TEMPORARY_FAILURE     5xx/network
   ```

- [ ] **Step 7:** Запустить тесты; ожидается PASS.
- [ ] **Step 8:** Commit: `feat: upload recordings to personal google drive`

### Task 2.6: Связать локальную запись, Drive и Gemini без блокировки end

**Files:** `apps/api/src/services/recording-assets.ts`, `apps/api/src/services/recording-assets.test.ts`, `apps/api/src/routes/meetings.ts`, `apps/api/src/services/gemini.ts`

**Interfaces:**

- Consumes: recording repository, upload route и Drive adapter.
- Produces: pipeline local → Drive/Gemini и retry endpoint.

- [ ] **Step 1:** Написать service-тесты: локальное сохранение всегда создаёт asset; Drive success обновляет asset; Drive failure сохраняет local path и error; Gemini failure не меняет Drive result; встреча остаётся ended при любой ошибке.
- [ ] **Step 2:** Запустить; ожидается FAIL.
- [ ] **Step 3:** В upload route выполнить строго:

   ```text
   validate multipart → stream to /data/audio temp → fsync/rename → sha256
   → upsert recording_asset(local) → response accepted
   → asynchronous Drive upload → asynchronous Gemini processing
   ```

- [ ] **Step 4:** Не удалять локальный файл автоматически в этой итерации. Удаление допускается отдельной retention-задачей только после подтверждённого `uploaded` и резервного периода.
- [ ] **Step 5:** Добавить bounded retry: 1 мин, 5 мин, 30 мин; максимум 3 автоматические попытки только для 429/5xx/network. 401/403 требуют действия администратора. Если постоянного worker-процесса нет, выполнить retry при startup reconciliation и ручным endpoint; не использовать `setTimeout` как единственный источник надёжности.
- [ ] **Step 6:** Добавить `POST /api/integrations/google-drive/recordings/:assetId/retry`, только admin; compare-and-set не допускает параллельные uploads.
- [ ] **Step 7:** Запустить тесты; ожидается PASS.
- [ ] **Step 8:** Commit: `feat: track resilient recording delivery independently`

### Task 2.7: Добавить честный UI подключения и статусов

**Files:** `apps/web/src/components/DriveConnectionCard.tsx`, `apps/web/src/components/DriveConnectionCard.test.tsx`, `apps/web/src/app/settings/page.tsx`, `apps/web/src/app/settings/settings.module.css`, `apps/web/src/lib/api.ts`

**Interfaces:**

- Consumes: Drive endpoints и `apiFetch`.
- Produces: `DriveConnectionCard` со всеми реальными состояниями.

- [ ] **Step 1:** Написать component-тесты состояний: disabled configuration, disconnected, connecting, connected email/folder, reauth required, upload error with retry.
- [ ] **Step 2:** Запустить `pnpm --filter web test`; ожидается FAIL.
- [ ] **Step 3:** Добавить в Settings карточку «Google Drive»:

   - «Подключить Google Drive» открывает backend connect URL;
   - connected показывает email, папку и дату;
   - «Переподключить» показывается только при reauth;
   - «Отключить» требует подтверждения и показывает результат реального API;
   - никаких полей service-account JSON.

- [ ] **Step 4:** Пояснение в UI: «Войдите один раз обычным Google-аккаунтом. Повторный вход нужен только если вы отзовёте доступ, смените OAuth-настройки или Google аннулирует токен».
- [ ] **Step 5:** После callback считывать `drive=connected|error`, показывать одноразовый banner и очищать query через `router.replace('/settings')`.
- [ ] **Step 6:** Запустить web-тесты; ожидается PASS.
- [ ] **Step 7:** Commit: `feat: add google drive connection settings`

### Task 2.8: Интеграционная проверка на обычном Google-аккаунте

**Files:** документация развёртывания и `.env.example`, если такая документация уже существует; не создавать второй competing README.

**Interfaces:**

- Consumes: готовый OAuth/upload pipeline.
- Produces: проверенный one-login upload/retry/reauth сценарий.

- [ ] **Step 1:** В Google Cloud создать OAuth Web Client, consent screen External/Production и redirect URI точь-в-точь из env.
- [ ] **Step 2:** Подключить личный аккаунт один раз и убедиться, что Settings показывает email без token data.
- [ ] **Step 3:** Провести короткую тестовую конференцию, завершить её и проверить:

   - UI сразу ended;
   - запись осталась локально;
   - `recording_assets.storage_status='uploaded'`;
   - файл появился в `Centras Echo Recordings`;
   - повторный retry не создал duplicate;
   - новая запись на следующий день не потребовала логина.

- [ ] **Step 4:** Временно отозвать доступ в Google Account и проверить `DRIVE_REAUTH_REQUIRED`, отсутствие потери локального файла и понятную кнопку переподключения.
- [ ] **Step 5:** Запустить:

   ```powershell
   pnpm --filter api test
   pnpm --filter web test
   pnpm build
   ```

- [ ] **Step 6:** Commit: `docs: document personal drive oauth setup and recovery`

### Приёмка Phase 2

- Ошибка service account 403 `storageQuotaExceeded` больше не возникает в новом пути.
- Один обычный Google-аккаунт подключается однократно; ежедневный повторный логин не требуется.
- Токен зашифрован в БД и отсутствует во frontend, URL и логах.
- У каждой записи виден реальный статус и диагностируемая ошибка.
- End конференции не ждёт Drive и не откатывается при ошибке загрузки.
- После временного сбоя возможен безопасный retry без duplicate.

---

## Phase 3 — Актуальные данные, настройки и формы

### Карта файлов

**Создать:**

- `apps/web/src/lib/api-errors.ts`
- `apps/web/src/lib/api.test.ts`
- `apps/web/src/hooks/use-meetings-data.ts`
- `apps/web/src/hooks/use-meetings-data.test.tsx`
- `apps/web/src/hooks/use-form-state.ts`
- `apps/web/src/hooks/use-form-state.test.ts`
- `apps/api/src/routes/profile.ts`
- `apps/api/src/routes/profile.test.ts`

**Изменить:**

- `apps/web/src/lib/api.ts`
- `apps/api/src/app.ts`
- `apps/api/src/routes/meetings.ts`
- `apps/api/src/routes/admin.ts`
- `apps/web/src/app/dashboard/page.tsx`
- `apps/web/src/app/dashboard/dashboard.module.css`
- `apps/web/src/app/archive/page.tsx`
- `apps/web/src/app/archive/[id]/page.tsx`
- `apps/web/src/app/settings/page.tsx`
- `apps/web/src/app/settings/settings.module.css`
- `apps/web/src/app/admin/page.tsx`
- `apps/web/src/app/admin/admin.module.css`

### Task 3.1: Сделать API-клиент предсказуемым

**Files:** `apps/web/src/lib/api.ts`, `apps/web/src/lib/api-errors.ts`, `apps/web/src/lib/api.test.ts`

**Interfaces:**

- Consumes: существующий `api.ts` и session helpers.
- Produces: `ApiError` и `apiFetch<T>()`.

- [ ] **Step 1:** Написать тесты:

   - GET добавляет `cache: "no-store"`;
   - 204 не вызывает JSON parse;
   - non-JSON error превращается в `ApiError` с status/code/message;
   - два параллельных 401 запускают только один refresh;
   - refresh failure очищает member session и редиректит на login, guest session очищает и ведёт на `/`;
   - AbortSignal/timeout отличимы от server error.

- [ ] **Step 2:** Запустить `pnpm --filter web exec vitest run src/lib/api.test.ts`; ожидается FAIL.
- [ ] **Step 3:** Реализовать:

   ```ts
   class ApiError extends Error {
     constructor(
       message: string,
       readonly status: number,
       readonly code: string,
       readonly details?: unknown,
     ) { super(message); }
   }
   ```

- [ ] **Step 4:** `apiFetch<T>` должен принимать `signal`, ставить `cache: "no-store"`, не ретраить mutation автоматически, дедуплицировать refresh promise и безопасно обрабатывать пустой ответ.
- [ ] **Step 5:** Убрать прямые `fetch` из страниц для внутренних API, кроме `keepalive` guest logout, где это технически требуется.
- [ ] **Step 6:** Запустить тест; ожидается PASS.
- [ ] **Step 7:** Commit: `fix: make api client cache-safe and deterministic`

### Task 3.2: Запретить кэш приватных данных на API

**Files:** `apps/api/src/app.ts`, `apps/api/src/routes/meetings.ts`, `apps/api/src/routes/profile.ts`, `apps/api/src/routes/admin.ts`, `apps/api/src/test/app.test.ts`

**Interfaces:**

- Consumes: Fastify hooks и stateful GET routes.
- Produces: единые `private, no-store` response headers.

- [ ] **Step 1:** Добавить inject-тесты заголовка для `/api/auth/me`, meetings list/detail/public-info, profile, archive, admin lists.
- [ ] **Step 2:** Запустить; ожидается FAIL на endpoints без `Cache-Control`.
- [ ] **Step 3:** Добавить Fastify hook для `/api/*` stateful GET:

   ```text
   Cache-Control: private, no-store, max-age=0
   Pragma: no-cache
   Vary: Authorization, Cookie
   ```

   Публичные неизменяемые assets Next.js не затрагивать.
- [ ] **Step 4:** Убедиться, что ETAG/conditional response не возвращает устаревший body для meeting state.
- [ ] **Step 5:** Запустить API-тесты; ожидается PASS.
- [ ] **Step 6:** Commit: `fix: disable caching for authenticated and meeting state`

### Task 3.3: Добавить управляемое обновление списков встреч

**Files:** `apps/web/src/hooks/use-meetings-data.ts`, `apps/web/src/hooks/use-meetings-data.test.tsx`

**Interfaces:**

- Consumes: `apiFetch` и meeting types.
- Produces: `useMeetingsData({ scope })` с защитой от stale responses.

- [ ] **Step 1:** Написать fake-timer тесты:

   - mount → один fetch;
   - window focus → refetch;
   - `online` → refetch;
   - `visibilitychange` в visible → refetch;
   - active meeting → polling каждые 5 секунд;
   - только ended/scheduled → polling выключен;
   - предыдущий запрос abort при unmount/новом запросе;
   - старый медленный response не перезаписывает новый.

- [ ] **Step 2:** Запустить; ожидается FAIL.
- [ ] **Step 3:** Реализовать `useMeetingsData({ scope: "dashboard" | "archive" })` с request sequence ID, AbortController, event listeners cleanup и `refresh()` после mutations.
- [ ] **Step 4:** Не очищать отображённые данные во время background refetch; показывать компактный индикатор «Обновляем…». Первичная загрузка и background refresh должны быть разными состояниями.
- [ ] **Step 5:** Запустить тест; ожидается PASS.
- [ ] **Step 6:** Commit: `feat: refresh meeting data on focus network and activity`

### Task 3.4: Подключить актуальность к Dashboard и архиву

**Files:** `apps/web/src/app/dashboard/page.tsx`, `apps/web/src/app/dashboard/dashboard.module.css`, `apps/web/src/app/archive/page.tsx`, `apps/web/src/app/archive/[id]/page.tsx`, `apps/web/src/hooks/use-meetings-data.ts`

**Interfaces:**

- Consumes: `useMeetingsData` и authoritative status.
- Produces: синхронизированные dashboard/archive views.

- [ ] **Step 1:** Написать component-тест: ended meeting после refetch перемещается из active в archive без reload; delete/end mutation вызывает `refresh()`; background error оставляет старые данные и показывает retry.
- [ ] **Step 2:** Запустить; ожидается FAIL.
- [ ] **Step 3:** Заменить одноразовые `useEffect` fetch на hook. Сортировать по серверным timestamps, статус брать только из `status`, а не вычислять из локального времени.
- [ ] **Step 4:** В archive detail при 404/403/410 показать отдельные состояния. Не сохранять предыдущую встречу при смене route ID.
- [ ] **Step 5:** Добавить кнопку «Повторить» и `aria-live="polite"` для background error.
- [ ] **Step 6:** Запустить web-тесты; ожидается PASS.
- [ ] **Step 7:** Commit: `fix: keep dashboard and archive synchronized`

### Task 3.5: Реализовать реальное редактирование профиля

**Files:** `apps/api/src/routes/profile.ts`, `apps/api/src/routes/profile.test.ts`, `apps/api/src/app.ts`, `apps/web/src/app/settings/page.tsx`, `apps/web/src/app/settings/settings.module.css`

**Interfaces:**

- Consumes: member guard и users table.
- Produces: `GET/PATCH /api/profile` и честную Settings form.

- [ ] **Step 1:** Добавить route-тесты:

   - `GET /api/profile` возвращает текущие реальные поля;
   - `PATCH /api/profile` валидирует имя 2–80 и разрешённые поля;
   - email/role/is_guest нельзя изменить этим endpoint;
   - guest → 403;
   - DB failure → 500, UI не показывает success.

- [ ] **Step 2:** Запустить; ожидается FAIL: текущий frontend вызывает несуществующий endpoint.
- [ ] **Step 3:** Реализовать `GET/PATCH /api/profile`, возвращая сохранённую запись.
- [ ] **Step 4:** В Settings инициализировать форму из GET; dirty-state считать по сравнению с server snapshot; success показывать только после PATCH 200; после ответа заменить snapshot значениями API.
- [ ] **Step 5:** Удалить или скрыть до отдельной реализации секции смены пароля, notifications и sessions, если у них нет реальных endpoints. Для Google-only account явно показать «Пароль управляется Google».
- [ ] **Step 6:** Запустить API и web-тесты; ожидается PASS.
- [ ] **Step 7:** Commit: `fix: connect settings profile to real api`

### Task 3.6: Унифицировать состояния и валидацию форм

**Files:** `apps/web/src/hooks/use-form-state.ts`, `apps/web/src/hooks/use-form-state.test.ts`, `apps/web/src/app/dashboard/page.tsx`, `apps/web/src/app/admin/page.tsx`, `apps/web/src/app/settings/page.tsx`, `apps/web/src/app/room/[id]/page.tsx`

**Interfaces:**

- Consumes: API error contract и формы.
- Produces: `useFormState()` и единые validation/submission states.

- [ ] **Step 1:** Написать reducer-тесты переходов:

   ```text
   idle → submitting → success → idle
   idle → submitting → error → submitting
   submitting + double submit → остаётся один request
   field edit → очищает только связанную field error
   ```

- [ ] **Step 2:** Запустить; ожидается FAIL.
- [ ] **Step 3:** Реализовать hook без сторонней библиотеки: `status`, `fieldErrors`, `formError`, `submit`, `reset`, `isDirty`.
- [ ] **Step 4:** Применить к формам:

   - guest name: trim, 2–80;
   - meeting title: trim, 3–120;
   - agenda/description: максимум из backend schema;
   - scheduled time: валидная дата и понятная timezone;
   - user/admin role: enum;
   - profile name: 2–80.

- [ ] **Step 5:** Backend должен повторять все security/data-integrity validations; frontend validation нужна для быстрой обратной связи, но не считается защитой.
- [ ] **Step 6:** На input проставить `label`, `id`, `name`, подходящий `autocomplete`, `aria-invalid`, `aria-describedby`. Первую ошибку фокусировать после submit.
- [ ] **Step 7:** Запустить тесты; ожидается PASS.
- [ ] **Step 8:** Commit: `fix: standardize form validation and submission states`

### Task 3.7: Исправить модальные окна и обратную связь

**Files:** `apps/web/src/app/dashboard/page.tsx`, `apps/web/src/app/dashboard/dashboard.module.css`, `apps/web/src/app/admin/page.tsx`, `apps/web/src/app/admin/admin.module.css`, `apps/web/src/app/settings/page.tsx`

**Interfaces:**

- Consumes: form state и dialogs.
- Produces: доступный modal primitive и правдивую feedback-модель.

- [ ] **Step 1:** Написать component-тесты: Escape закрывает; backdrop click закрывает; click внутри не закрывает; destructive action требует confirm; focus возвращается trigger; submit button disabled только пока request pending.
- [ ] **Step 2:** Запустить; ожидается FAIL.
- [ ] **Step 3:** Сделать общий локальный modal primitive, если уже нет существующего: `role="dialog"`, `aria-modal="true"`, заголовок через `aria-labelledby`, focus trap, body scroll lock с cleanup.
- [ ] **Step 4:** Заменить `alert()` и ложные toast-сообщения на inline banner/toast, завязанный на реальный response. Ошибки не исчезают автоматически до исправления/повтора; success может закрыться через 4–6 секунд.
- [ ] **Step 5:** Для удаления встречи/пользователя показывать конкретное имя объекта и irreversible-текст; disable повторный submit.
- [ ] **Step 6:** Запустить тесты; ожидается PASS.
- [ ] **Step 7:** Commit: `fix: make dialogs accessible and feedback truthful`

### Task 3.8: Сквозная проверка актуальности и форм

**Files:** изменённые файлы этого плана.

**Interfaces:**

- Consumes: все Tasks Phase 3.
- Produces: cross-tab freshness и regression coverage.

- [ ] **Step 1:** Выполнить сценарии в двух вкладках:

   - вкладка A завершает встречу, вкладка B становится видимой и не позднее 1 секунды начинает refetch;
   - при active-встрече вкладка B видит ended не позднее 5 секунд;
   - offline → online запускает refresh;
   - медленный старый response не возвращает карточку в active;
   - ошибки profile/admin/delete не показывают success.

- [ ] **Step 2:** Запустить:

   ```powershell
   pnpm --filter api test
   pnpm --filter web test
   pnpm build
   ```

- [ ] **Step 3:** Проверить Network: stateful GET содержит request `cache-control: no-cache`/fetch no-store, response содержит `private, no-store`; нет бесконечного polling для неактивных экранов.
- [ ] **Step 4:** Commit: `test: cover freshness forms and cross-tab regressions`

### Приёмка Phase 3

- Dashboard/archive обновляются на focus, visible, online и во время active-встреч.
- Старый response не перезаписывает новый.
- Настройки сохраняют только существующие backend-функции и показывают ответ API.
- Во всех формах есть loading, field error, form error и success; double submit исключён.
- Модальные окна управляются клавиатурой и возвращают focus.
- Тесты и production build проходят без новых предупреждений.

---

## Phase 4 — UI, адаптивность, производительность и финальный QA

### Карта файлов

**Создать:**

- `apps/web/src/app/room/[id]/components/RoomShell.tsx`
- `apps/web/src/app/room/[id]/components/RoomStage.tsx`
- `apps/web/src/app/room/[id]/components/RoomControls.tsx`
- `apps/web/src/app/room/[id]/components/ParticipantsPanel.tsx`
- `apps/web/src/app/room/[id]/components/ChatPanel.tsx`
- `apps/web/src/app/room/[id]/components/MeetingEnded.tsx`
- `apps/web/src/app/room/[id]/hooks/use-room-lifecycle.ts`
- `apps/web/src/app/room/[id]/hooks/use-recorder.ts`
- `apps/web/src/app/room/[id]/room.test.tsx`
- `apps/web/src/components/Modal.tsx` — только если Phase 3 не создал общий primitive.
- `docs/qa/2026-08-31-ui-performance-report.md`

**Изменить:**

- `apps/web/src/app/globals.css`
- `apps/web/src/app/layout.tsx`
- `apps/web/src/app/page.tsx`
- `apps/web/src/app/login/page.tsx`
- `apps/web/src/app/login/login.module.css`
- `apps/web/src/app/dashboard/page.tsx`
- `apps/web/src/app/dashboard/dashboard.module.css`
- `apps/web/src/app/archive/page.tsx`
- `apps/web/src/app/archive/archive.module.css`
- `apps/web/src/app/archive/[id]/page.tsx`
- `apps/web/src/app/archive/[id]/protocol.module.css`
- `apps/web/src/app/settings/page.tsx`
- `apps/web/src/app/settings/settings.module.css`
- `apps/web/src/app/admin/page.tsx`
- `apps/web/src/app/admin/admin.module.css`
- `apps/web/src/app/room/[id]/page.tsx`
- `apps/web/src/app/room/[id]/room.module.css`

### Task 4.1: Зафиксировать визуальный и performance baseline

**Files:** `docs/qa/2026-08-31-ui-performance-report.md`

**Interfaces:**

- Consumes: production build и тестовые member/guest flows.
- Produces: baseline screenshots, route sizes и Core Web Vitals.

- [ ] **Step 1:** Запустить production build и локальный production server:

   ```powershell
   pnpm build
   pnpm --filter web start
   ```

- [ ] **Step 2:** С помощью `design-review` и browser skill пройти desktop 1440×900, tablet 768×1024, mobile 390×844 и minimum 320×568 по экранам: landing, login, dashboard empty/list/modal, public guest form, room, ended room, archive list/detail, settings, admin.
- [ ] **Step 3:** Для защищённых экранов использовать отдельного тестового member и guest; не импортировать реальные production cookies в отчёт.
- [ ] **Step 4:** Зафиксировать screenshots, overflow, clipped controls, keyboard path, console errors, failed network calls, route JS sizes и Lighthouse mobile: Performance, Accessibility, LCP, INP/TBT, CLS.
- [ ] **Step 5:** В отчёте записать измеренные baseline и budgets:

   ```text
   /room/[id] route own JS: уменьшить минимум на 15% от baseline
   CLS: <= 0.10
   LCP mobile local/prod-like: <= 2.5 s
   Accessibility: >= 95
   critical horizontal overflow: 0
   console errors in core flows: 0
   ```

- [ ] **Step 6:** Commit: `docs: capture responsive and performance baseline`

### Task 4.2: Разделить room page с characterization-тестами

**Files:** `apps/web/src/app/room/[id]/room.test.tsx`, `apps/web/src/app/room/[id]/page.tsx`, новые room components/hooks.

**Interfaces:**

- Consumes: исправленный room flow Phases 1–3.
- Produces: characterization tests и focused room hooks/components.

- [ ] **Step 1:** До extraction написать тесты текущего пользовательского поведения: guest form, joining, connected controls, host end, guest leave/logout, disconnected, recorder success/failure, ended state.
- [ ] **Step 2:** Запустить; ожидается PASS на существующем поведении после mock LiveKit/MediaRecorder. Если тест выявляет уже известный bug из Phase 1, ожидание должно соответствовать исправленному контракту, сначала увидеть FAIL, затем подтвердить PASS после Phase 1.
- [ ] **Step 3:** Извлекать по одному слою, сохраняя public props:

   ```text
   page.tsx: orchestration + route ID
   use-room-lifecycle: status/join/leave/end
   use-recorder: MediaRecorder state and upload handoff
   RoomShell: responsive regions
   RoomStage: media grid
   RoomControls: primary controls
   ChatPanel / ParticipantsPanel: optional panels
   MeetingEnded: terminal public state
   ```

- [ ] **Step 4:** После каждого extraction запускать `pnpm --filter web test -- room.test.tsx`; ожидается PASS.
- [ ] **Step 5:** Не дублировать guest cleanup в компонентах: только `use-room-lifecycle` вызывает helper Phase 1.
- [ ] **Step 6:** Commit: `refactor: split room page into tested features`

### Task 4.3: Снизить первоначальный JavaScript комнаты

**Files:** `apps/web/src/app/room/[id]/page.tsx`, `ChatPanel.tsx`, `ParticipantsPanel.tsx`, при необходимости отдельные необязательные панели.

**Interfaces:**

- Consumes: room components.
- Produces: dynamic optional panels и минимум −15% route-own JS.

- [ ] **Step 1:** Добавить тесты, что закрытые optional panels не рендерятся, открытие показывает loading label и затем содержимое, controls работают до загрузки панели.
- [ ] **Step 2:** Использовать `next/dynamic` для chat/participants/analytics/transcript компонентов, которые не нужны до открытия. Не dynamic-import критический stage/control bar.
- [ ] **Step 3:** Стабилизировать callbacks через `useCallback` только там, где это предотвращает реальный rerender memoized child; не добавлять механическую мемоизацию.
- [ ] **Step 4:** Удалить дублируемые state/effects и listener leaks; каждый LiveKit/window listener должен иметь точный cleanup.
- [ ] **Step 5:** Собрать `pnpm build`, сравнить route sizes с baseline; при снижении менее 15% снять bundle report и вынести следующий самый тяжёлый optional dependency.
- [ ] **Step 6:** Commit: `perf: defer noncritical room panels`

### Task 4.4: Ввести единые design tokens и базовую доступность

**Files:** `apps/web/src/app/globals.css`, `apps/web/src/app/layout.tsx`, все перечисленные CSS modules.

**Interfaces:**

- Consumes: существующий бренд и CSS Modules.
- Produces: semantic tokens и accessibility baseline.

- [ ] **Step 1:** В `:root` определить существующий бренд через semantic tokens, не менять визуальную идентичность произвольно:

   ```css
   --color-bg; --color-surface; --color-surface-raised;
   --color-text; --color-text-muted; --color-border;
   --color-primary; --color-primary-hover; --color-danger;
   --radius-sm; --radius-md; --radius-lg;
   --space-1 ... --space-8;
   --shadow-1; --shadow-2;
   --focus-ring;
   ```

- [ ] **Step 2:** Удалить локальные почти-одинаковые цвета/радиусы в пользу tokens. Проверить contrast обычного текста >=4.5:1, крупного >=3:1.
- [ ] **Step 3:** Добавить глобальный `:focus-visible`; не удалять outline без эквивалентного ring.
- [ ] **Step 4:** Для icon-only buttons добавить accessible name и tooltip только как дополнение, не замену aria-label.
- [ ] **Step 5:** Добавить skip link до main content и семантические `header/nav/main`; ровно один h1 на экран.
- [ ] **Step 6:** Commit: `style: unify interface tokens and accessibility states`

### Task 4.5: Перестроить room layout mobile-first

**Files:** `apps/web/src/app/room/[id]/components/RoomShell.tsx`, `RoomStage.tsx`, `RoomControls.tsx`, `apps/web/src/app/room/[id]/room.module.css`, `room.test.tsx`

**Interfaces:**

- Consumes: `RoomShell`, `RoomStage`, `RoomControls`.
- Produces: mobile-first room layout 320×568–1440×900.

- [ ] **Step 1:** Добавить behavior-тесты DOM-order: stage до controls, primary leave всегда в DOM, panels имеют accessible toggle/close.
- [ ] **Step 2:** Реализовать breakpoints по потребности контента:

   - 320–599: один stage, нижняя sticky control bar, panels как full-height sheet;
   - 600–1023: stage + overlay/drawer panel;
   - >=1024: stage + docked side panel;
   - высота <=650: compact controls/spacing без скрытия leave/end.

- [ ] **Step 3:** Учесть `env(safe-area-inset-bottom)`; не использовать фиксированные ширины, создающие overflow; media grid `minmax(0, 1fr)`.
- [ ] **Step 4:** Основные controls touch 44×44; destructive end визуально отделён; labels не зависят только от hover.
- [ ] **Step 5:** На narrow screen secondary controls сворачиваются в «Ещё», но mic/camera/leave остаются прямыми.
- [ ] **Step 6:** Запустить component-тесты и browser screenshots на 320×568, 390×844, 768×1024, 1440×900.
- [ ] **Step 7:** Commit: `style: make conference room responsive and touch friendly`

### Task 4.6: Исправить адаптивность остальных экранов и форм

**Files:** landing/login/dashboard/archive/settings/admin page и module CSS.

**Interfaces:**

- Consumes: tokens и forms Phase 3.
- Produces: адаптивные landing/login/dashboard/archive/settings/admin экраны.

- [ ] **Step 1:** Landing/login: ограничить line length, убрать скачки высоты, корректная клавиатура/zoom на mobile; font-size inputs >=16px.
- [ ] **Step 2:** Dashboard/archive: карточки/grid переходят в одну колонку; таблицы admin имеют semantic mobile cards либо горизонтальный scroll с видимой подсказкой, но action buttons не обрезаются.
- [ ] **Step 3:** Формы/modal: desktop max-width, mobile width `calc(100vw - 32px)`, max-height с внутренним scroll, sticky action row; error text не меняет расположение соседних полей непредсказуемо.
- [ ] **Step 4:** Settings: секции профиля/Drive читаются одной колонкой на narrow screens; connected email переносится; длинные error codes не создают overflow.
- [ ] **Step 5:** Archive protocol: длинные слова/URL переносятся, preformatted content имеет controlled overflow, print styles не теряют текст.
- [ ] **Step 6:** Browser-проверка каждой страницы при 200% zoom и клавиатуре.
- [ ] **Step 7:** Commit: `style: improve responsive forms dashboards and archive`

### Task 4.7: Убрать визуальные и motion-регрессии

**Files:** `apps/web/src/app/globals.css`, CSS modules, `apps/web/src/components/Modal.tsx` при наличии.

**Interfaces:**

- Consumes: responsive layouts и UI states.
- Produces: reduced-motion, stable skeleton и state polish.

- [ ] **Step 1:** Добавить skeleton только для первичной загрузки; background refresh не должен заменять контент skeleton-ом.
- [ ] **Step 2:** Все transitions ограничить `opacity/transform`; не анимировать layout-critical width/height. Длительность 120–220 ms.
- [ ] **Step 3:** Добавить:

   ```css
   @media (prefers-reduced-motion: reduce) {
     *, *::before, *::after {
       animation-duration: 0.01ms !important;
       animation-iteration-count: 1 !important;
       scroll-behavior: auto !important;
       transition-duration: 0.01ms !important;
     }
   }
   ```

- [ ] **Step 4:** Проверить empty/error/success/loading/ended/offline состояния каждой страницы; не оставлять layout, рассчитанный только на happy path.
- [ ] **Step 5:** Commit: `style: polish loading error and reduced motion states`

### Task 4.8: Провести финальную функциональную, security и performance верификацию

**Files:** `docs/qa/2026-08-31-ui-performance-report.md`, все изменённые файлы планов 01–04.

**Interfaces:**

- Consumes: все Phases и baseline Task 4.1.
- Produces: финальный QA-report, benchmark, adversarial review и release gate.

- [ ] **Step 1:** Выполнить полный набор:

   ```powershell
   pnpm --filter api test
   pnpm --filter web test
   pnpm lint
   pnpm build
   git diff --check
   ```

   Ожидается: exit code 0; существующие baseline warnings отдельно перечислены и не маскируют новые.
- [ ] **Step 2:** Выполнить browser regression matrix:

   ```text
   member login/logout/refresh
   Google login/refresh/logout
   public guest join/leave/disconnect/refresh
   host end + connected guest
   ended public link
   recording success/Drive failure/retry/reauth
   dashboard two-tab freshness
   every form success and server error
   keyboard-only modal and room controls
   320×568 / 390×844 / 768×1024 / 1440×900
   ```

- [ ] **Step 3:** Запустить `design-review` повторно и исправлять только найденные подтверждённые defects; после каждого исправления повторять затронутый сценарий.
- [ ] **Step 4:** Запустить `benchmark`, сравнить с Task 1. Записать before/after route JS, LCP, CLS, Accessibility и screenshots в отчёт. Budget failure блокирует завершение либо требует явно документированного технического объяснения и отдельной задачи.
- [ ] **Step 5:** Выполнить adversarial review по границам доверия:

   - guest token против чужого meeting ID;
   - ended meeting join race;
   - повторные logout/end/upload retry;
   - OAuth state replay;
   - token leakage в logs/URL/client bundle;
   - Drive outage при завершении.

- [ ] **Step 6:** Просмотреть итоговый diff через `superpowers:requesting-code-review`; устранить P0/P1/P2, повторить тесты.
- [ ] **Step 7:** Commit: `test: complete conference reliability and responsive qa`

### Приёмка Phase 4

- Все основные экраны пригодны при 320×568, 390×844, 768×1024 и 1440×900 без критического horizontal overflow.
- Mic, camera, leave/end доступны без прокрутки и имеют touch target >=44×44.
- `/room/[id]` initial route JS уменьшен минимум на 15% относительно зафиксированного baseline.
- Lighthouse Accessibility >=95, CLS <=0.10, критические console errors отсутствуют.
- Keyboard, focus, 200% zoom и reduced motion проходят ручную проверку.
- Полная regression matrix подтверждает fixes Phases 1–3.

---

## Итоговый release gate

- [ ] Все 32 Task выполнены и имеют подтверждённый red/green цикл.
- [ ] `pnpm --filter api test`, `pnpm --filter web test`, `pnpm lint`, `pnpm build`, `git diff --check` завершаются с exit code 0.
- [ ] Guest join/leave/disconnect/refresh, host end, ended public link и two-tab freshness проверены вручную.
- [ ] Одна OAuth-авторизация обычного Google-аккаунта сохраняет последующие записи без ежедневного входа.
- [ ] Drive 401/403/429/5xx не меняют ended-статус и не уничтожают локальную запись.
- [ ] Responsive matrix 320×568, 390×844, 768×1024, 1440×900 не содержит критического overflow.
- [ ] Route-own JavaScript комнаты уменьшен минимум на 15%; Accessibility >=95; CLS <=0.10.
- [ ] Security review не выявляет token leakage, scope bypass, OAuth state replay или race повторного end/upload.
- [ ] Before/after QA-отчёт содержит screenshots, bundle metrics, Core Web Vitals и остаточные ограничения.

