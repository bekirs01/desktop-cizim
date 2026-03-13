# Что нужно сделать для деплоя на Railway

## Шаг 1. Отправь код на GitHub

В терминале выполни:

```bash
git add .
git commit -m "Railway deploy config"
git push
```

---

## Шаг 2. Создай проект в Railway

1. Открой [railway.app](https://railway.app)
2. Войди через **GitHub**
3. Нажми **New Project**
4. Выбери **Deploy from GitHub repo**
5. Выбери свой репозиторий

---

## Шаг 3. Получи URL приложения

1. В Railway открой свой проект
2. Перейди в **Settings** → **Networking**
3. Нажми **Generate Domain**
4. Скопируй URL (например: `https://desktop-cizim-production.up.railway.app`)

---

## Шаг 4. Настрой Supabase Auth

1. Открой [Supabase Dashboard](https://supabase.com/dashboard)
2. Выбери свой проект
3. Перейди в **Authentication** → **URL Configuration**
4. В поле **Site URL** вставь свой Railway URL (из шага 3)
5. В **Redirect URLs** добавь: `https://твой-url.up.railway.app/**` (подставь свой URL)
6. Сохрани изменения

---

## Шаг 5. Готово

После деплоя открой свой Railway URL. Ссылки на PDF будут работать для друзей.

---

## Если сборка падает с ошибкой

1. В Railway открой проект → **Settings** → **Build**
2. В **Custom Build Command** вставь:
```
npm install serve && npm cache clean --force
```
3. Сохрани и перезапусти деплой
