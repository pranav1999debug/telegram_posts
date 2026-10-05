# Telegram Posts Bot

A private Telegram bot that lets you send a title, cover picture, content images/videos, and links. It then:

1. Uploads images to ImgChest.
2. Uploads videos to Catbox.
3. Generates a description and hashtags from the title with Groq.
4. Stores the result in your Supabase `posts` table.
5. Publishes a free version and, if configured, a premium version to Telegram channels.

## Important security step

The credentials originally pasted into chat are considered exposed. **Rotate the Telegram bot token, Groq key, Supabase credentials, ImgChest token, and Catbox userhash before using this project.** Never put live secrets in GitHub source files.

## What you still need to do

1. Create replacement credentials in BotFather, Groq, ImgChest, and Supabase.
2. Run `supabase/001_posts_columns.sql` in Supabase SQL Editor.
3. Add the bot as an administrator in each destination channel with permission to post messages.
4. Find your Telegram numeric user ID and put it in `ADMIN_USER_IDS`.
5. Fill in `.env` using `.env.example`.
6. Install and run with `npm install && npm run build && npm start`.

## Bot commands

- `/new` — start a post.
- Send the title.
- Send the cover picture, or `/skip`.
- Send content images/videos one by one.
- `/done` — finish media intake.
- Send the free link, premium link, and direct link. Use `/skip` for optional links.
- `/cancel` — abandon the draft.

## Supabase

The bot uses the server-side `SUPABASE_SERVICE_ROLE_KEY` because the insert must work regardless of Row Level Security. Keep it only in the hosting provider’s secret manager. The migration adds these fields to `public.posts` without deleting existing columns:

`title`, `description`, `hashtags`, `cover_url`, `content_urls`, `free_link`, `premium_link`, `direct_link`, `telegram_message_ids`, `status`, `source`, `created_at`.

If your existing `posts` table has required columns not listed above, add those fields to the insert in `src/index.ts`.

## Hosting

This bot uses Telegram long polling, so it can run on a worker service such as Render, Railway, Fly.io, or a small VPS. Configure the service to run:

```bash
npm install
npm run build
npm start
```

Do not run two copies with the same bot token at the same time, or Telegram will reject one polling connection.

## Local test

```bash
cp .env.example .env
# edit .env with replacement secrets
npm install
npm run check
npm run dev
```
