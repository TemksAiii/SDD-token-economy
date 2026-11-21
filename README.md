# SpecTrim SDD Workbench

Интерактивный стенд для оценки и демонстрации методов оптимизации расхода токенов в Spec-Driven Development: Spec Slicer, AST-LOD & Hashline, Log Compressor, Zero-Token Pre-Review Gate и A/B-бенчмарк.

Проект запускается как веб-приложение с Express-сервером и Vite на порту `3000`.

## Требования

- Node.js 22.12 или новее
- npm 10 или новее
- Git

Проверить установку:

```powershell
node --version
npm --version
git --version
```

Если Node.js отсутствует, установите актуальную LTS-версию с официального сайта:

- https://nodejs.org/

Для Windows также можно установить Node.js через `winget`:

```powershell
winget install OpenJS.NodeJS.LTS
```

После установки откройте новый терминал, чтобы обновлённый `PATH` стал доступен.

## Установка

### 1. Клонировать репозиторий

```powershell
git clone https://github.com/lLightly/SDD-token-economy.git
cd SDD-token-economy
```

Если репозиторий уже клонирован, перейдите в его каталог:

```powershell
cd путь\к\SDD-token-economy
```

### 2. Установить зависимости

В корне проекта выполните:

```powershell
npm install
```

Файла блокировки зависимостей в репозитории нет, поэтому для обычной локальной установки используется `npm install`.

### 3. Настроить переменные окружения

Для текущего локального запуска переменные окружения не обязательны: приложение использует встроенный демо-набор данных и локальные API Express.

Файл `.env.example` сохранён для совместимости со средой Google AI Studio. При необходимости создать локальный `.env`:

```powershell
Copy-Item .env.example .env
```

Затем при необходимости замените значения в `.env`:

```dotenv
GEMINI_API_KEY="ваш_ключ"
APP_URL="http://localhost:3000"
```

Ключ Gemini API для локального запуска без Google AI Studio не используется сервером `server.ts`.

## Запуск в режиме разработки

Из корня проекта выполните:

```powershell
npm run dev
```

Затем откройте в браузере:

- http://localhost:3000
- Проверка сервера: http://localhost:3000/api/health

Ожидаемый ответ проверки сервера:

```json
{
  "status": "ok",
  "service": "spectrim-sdd-workbench"
}
```

Для остановки сервера нажмите `Ctrl+C` в терминале.

## Запуск production-сборки локально

### Windows PowerShell

```powershell
npm run build
$env:NODE_ENV="production"
npm start
```

### Windows Command Prompt

```bat
npm run build
set NODE_ENV=production
npm start
```

### macOS или Linux

```bash
npm run build
NODE_ENV=production npm start
```

Приложение снова будет доступно по адресу http://localhost:3000.

Production-сборка берётся из каталога `dist`. Не удаляйте этот каталог до запуска сервера в production-режиме.

## Основные команды

| Команда | Назначение |
| --- | --- |
| `npm run dev` | Запустить сервер разработки с Vite middleware |
| `npm start` | Запустить Express-сервер |
| `npm run build` | Собрать production-версию в `dist/` |
| `npm run preview` | Запустить отдельный preview-сервер Vite для сборки |
| `npm run lint` | Проверить TypeScript с помощью `tsc --noEmit` |
| `npm run clean` | Удалить `dist/` и `server.js` |

## Проверка проекта

Проверить типы:

```powershell
npm run lint
```

Запустить unit-тесты движков:

```powershell
npx tsx --test "src/**/*.test.ts"
```

Собрать production-сборку:

```powershell
npm run build
```

Тестовые файлы находятся в каталоге `src/engine/` и покрывают:

- A/B-бенчмарк;
- AST-LOD и Hashline;
- Spec Slicer;
- Pre-Review Gate;
- компрессор вывода;
- определение переносимости репозиториев.

## Доступные API

Все API доступны на том же хосте и порту, что и веб-интерфейс.

| Метод | Путь | Назначение |
| --- | --- | --- |
| `GET` | `/api/health` | Проверка работоспособности сервера |
| `POST` | `/api/benchmark` | Запуск A/B-бенчмарка |
| `POST` | `/api/slice` | Слайсинг OpenSpec-конфигурации |
| `POST` | `/api/ast-lod` | Построение AST-LOD представления |
| `POST` | `/api/hashline-patch` | Применение Hashline-патча |
| `POST` | `/api/compress` | Сжатие git diff или тестового вывода |
| `POST` | `/api/gate` | Проверка Pre-Review Gate |
| `GET` | `/api/portability` | Анализ переносимости демо-репозиториев |

Пример проверки health API:

```powershell
Invoke-RestMethod -Uri "http://localhost:3000/api/health"
```

Через `curl`:

```bash
curl http://localhost:3000/api/health
```

## Как пользоваться приложением

1. Откройте http://localhost:3000.
2. На странице «Обзор A/B» настройте параметры и запустите бенчмарк.
3. Откройте «Модули SpecTrim», чтобы посмотреть отдельные компоненты оптимизации.
4. На странице «Портативность» изучите анализ поддержки языков репозитория.
5. На странице «Отчёт жюри» получите метрики и сформированные deliverables.

В приложении используются встроенные демо-данные из `src/data/demoWorkspace.ts`; для основных сценариев внешняя база данных или отдельный сервер не нужны.

## Структура проекта

```text
.
├── src/
│   ├── components/       # React-компоненты страниц
│   ├── data/             # Демо-наборы и исходные спецификации
│   ├── engine/           # Логика бенчмарка и модулей
│   ├── App.tsx           # Корневой React-компонент
│   ├── index.css         # Глобальные стили
│   └── main.tsx          # Точка входа React
├── server.ts             # Express-сервер и API
├── vite.config.ts        # Конфигурация Vite
├── package.json          # Скрипты и зависимости
├── tsconfig.json         # Настройки TypeScript
└── index.html            # HTML-шаблон приложения
```

## Решение типичных проблем

### Порт 3000 занят

По умолчанию сервер использует фиксированный порт `3000`. Если процесс не запускается из-за занятости порта, найдите и остановите процесс, который занимает порт.

Windows PowerShell:

```powershell
Get-NetTCPConnection -LocalPort 3000 -State Listen
```

Linux/macOS:

```bash
lsof -i :3000
```

Чтобы изменить порт, укажите новое значение в константе `PORT` в `server.ts`:

```ts
const PORT = 3000;
```

### Команда `npm` не найдена

1. Установите Node.js LTS.
2. Закройте и снова откройте терминал.
3. Проверьте `node --version` и `npm --version`.

### Зависимости не устанавливаются

Удалите локальную папку зависимостей и установите их заново:

```powershell
Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue
npm install
```

На macOS/Linux:

```bash
rm -rf node_modules
npm install
```

### Production-сервер показывает только пустую страницу

Сначала выполните сборку:

```powershell
npm run build
```

Убедитесь, что каталог `dist/` создан, затем запустите сервер с переменной `NODE_ENV=production`.
