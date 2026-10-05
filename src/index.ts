import 'dotenv/config';
import { Bot, Context, GrammyError, HttpError, InlineKeyboard, session, type SessionFlavor } from 'grammy';
import { createClient } from '@supabase/supabase-js';

type MediaItem = { kind: 'image' | 'video'; telegramFileId: string; fileName: string; mimeType?: string; hostedUrl?: string };
type Draft = { title?: string; cover?: MediaItem; media: MediaItem[]; freeLink?: string; premiumLink?: string; directLink?: string };
type SessionData = { step?: 'title' | 'cover' | 'media' | 'free' | 'premium' | 'direct'; draft?: Draft };
type BotContext = Context & SessionFlavor<SessionData>;

const required = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
  return value;
};
const csv = (value: string | undefined): string[] => (value ?? '').split(',').map((v) => v.trim()).filter(Boolean);

const config = {
  token: required('TELEGRAM_BOT_TOKEN'),
  admins: new Set(csv(required('ADMIN_USER_IDS'))),
  freeChannel: process.env.TELEGRAM_FREE_CHANNEL_ID,
  premiumChannel: process.env.TELEGRAM_PREMIUM_CHANNEL_ID,
  supabaseUrl: required('SUPABASE_URL'),
  supabaseKey: required('SUPABASE_SERVICE_ROLE_KEY'),
  postsTable: process.env.SUPABASE_POSTS_TABLE || 'posts',
  imgChestToken: required('IMG_CHEST_TOKEN'),
  catboxUserhash: process.env.CATBOX_USERHASH || '',
  groqKey: required('GROQ_API_KEY'),
  groqModel: process.env.GROQ_MODEL || 'llama-3.3-70b-versatile',
  maxMedia: Number(process.env.MAX_MEDIA_ITEMS || 20),
};

const bot = new Bot<BotContext>(config.token);
const supabase = createClient(config.supabaseUrl, config.supabaseKey, { auth: { persistSession: false } });

function isAdmin(ctx: BotContext): boolean {
  return Boolean(ctx.from && config.admins.has(String(ctx.from.id)));
}
function ensureAdmin(ctx: BotContext): boolean {
  if (isAdmin(ctx)) return true;
  void ctx.reply('This bot is private. Ask the owner to add your Telegram user ID to ADMIN_USER_IDS.');
  return false;
}
function reset(ctx: BotContext): void { ctx.session = {}; }
function mediaFromMessage(ctx: BotContext): MediaItem | null {
  const message = ctx.message;
  if (!message) return null;
  if ('photo' in message && message.photo?.length) {
    const photo = message.photo[message.photo.length - 1];
    if (!photo) return null;
    return { kind: 'image', telegramFileId: photo.file_id, fileName: `telegram-${photo.file_unique_id}.jpg`, mimeType: 'image/jpeg' };
  }
  if ('video' in message) {
    const video = message.video;
    if (!video) return null;
    return { kind: 'video', telegramFileId: video.file_id, fileName: video.file_name || `telegram-${video.file_unique_id}.mp4`, mimeType: video.mime_type || 'video/mp4' };
  }
  if ('document' in message) {
    const document = message.document;
    if (!document) return null;
    const mime = document.mime_type || '';
    if (mime.startsWith('image/')) return { kind: 'image', telegramFileId: document.file_id, fileName: document.file_name || 'image', mimeType: mime };
    if (mime.startsWith('video/')) return { kind: 'video', telegramFileId: document.file_id, fileName: document.file_name || 'video', mimeType: mime };
  }
  return null;
}

async function telegramFileBytes(fileId: string): Promise<ArrayBuffer> {
  const file = await bot.api.getFile(fileId);
  if (!file.file_path) throw new Error('Telegram did not return a file path.');
  const response = await fetch(`https://api.telegram.org/file/bot${config.token}/${file.file_path}`);
  if (!response.ok) throw new Error(`Telegram media download failed: ${response.status}`);
  return response.arrayBuffer();
}

async function uploadImage(item: MediaItem, title: string): Promise<string> {
  const bytes = await telegramFileBytes(item.telegramFileId);
  const form = new FormData();
  form.append('title', title.slice(0, 200));
  form.append('privacy', 'hidden');
  form.append('images[]', new Blob([bytes], { type: item.mimeType || 'image/jpeg' }), item.fileName);
  const response = await fetch('https://api.imgchest.com/v1/post', { method: 'POST', headers: { Authorization: `Bearer ${config.imgChestToken}` }, body: form });
  const payload = await response.json() as { data?: { images?: Array<{ link?: string }> }; message?: string };
  if (!response.ok || !payload.data?.images?.[0]?.link) throw new Error(`ImgChest upload failed: ${payload.message || response.status}`);
  return payload.data.images[0].link;
}

async function uploadVideo(item: MediaItem): Promise<string> {
  const bytes = await telegramFileBytes(item.telegramFileId);
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  if (config.catboxUserhash) form.append('userhash', config.catboxUserhash);
  form.append('fileToUpload', new Blob([bytes], { type: item.mimeType || 'video/mp4' }), item.fileName);
  const response = await fetch('https://catbox.moe/user/api.php', { method: 'POST', body: form });
  const url = (await response.text()).trim();
  if (!response.ok || !url.startsWith('https://')) throw new Error(`Catbox upload failed: ${url || response.status}`);
  return url;
}

async function generateCopy(title: string): Promise<{ description: string; hashtags: string }> {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST', headers: { Authorization: `Bearer ${config.groqKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: config.groqModel, temperature: 0.7, response_format: { type: 'json_object' }, messages: [
      { role: 'system', content: 'You write concise, factual Telegram post copy. Return only JSON with string fields description and hashtags. Hashtags must be space-separated and start with #. Do not invent specific facts not present in the title.' },
      { role: 'user', content: `Title: ${title}` },
    ] }),
  });
  const payload = await response.json() as { choices?: Array<{ message?: { content?: string } }>; error?: { message?: string } };
  if (!response.ok) throw new Error(`Groq request failed: ${payload.error?.message || response.status}`);
  const content = payload.choices?.[0]?.message?.content;
  if (!content) throw new Error('Groq returned no content.');
  const parsed = JSON.parse(content) as { description?: string; hashtags?: string };
  return { description: parsed.description?.trim() || title, hashtags: parsed.hashtags?.trim() || '' };
}

function linkLines(draft: Draft, premium: boolean): string {
  const lines = [`🔗 Free: ${draft.freeLink || 'Not provided'}`];
  if (premium && draft.premiumLink) lines.push(`⭐ Premium: ${draft.premiumLink}`);
  if (draft.directLink) lines.push(`⬇️ Direct: ${draft.directLink}`);
  return lines.join('\n');
}

async function publish(channel: string | undefined, draft: Draft, copy: { description: string; hashtags: string }, premium: boolean): Promise<number | undefined> {
  if (!channel) return undefined;
  const caption = [
    `🎬 ${draft.title}`,
    '', copy.description, copy.hashtags,
    '', linkLines(draft, premium),
  ].filter(Boolean).join('\n');
  const message = draft.cover?.telegramFileId
    ? await bot.api.sendPhoto(channel, draft.cover.telegramFileId, { caption: caption.slice(0, 1024) })
    : await bot.api.sendMessage(channel, caption.slice(0, 4096));
  return message.message_id;
}

async function finalize(ctx: BotContext): Promise<void> {
  const draft = ctx.session.draft;
  if (!draft?.title || !draft.freeLink) { await ctx.reply('Missing title or free link. Use /new to start again.'); reset(ctx); return; }
  if (draft.media.length > config.maxMedia) throw new Error(`Too many media items; maximum is ${config.maxMedia}.`);
  await ctx.reply('Uploading media and generating the AI description…');
  const contentUrls: Array<{ kind: string; url: string; fileName: string }> = [];
  for (const item of draft.media) {
    const url = item.kind === 'image' ? await uploadImage(item, draft.title) : await uploadVideo(item);
    contentUrls.push({ kind: item.kind, url, fileName: item.fileName });
  }
  const coverUrl = draft.cover ? await uploadImage(draft.cover, draft.title) : null;
  const copy = await generateCopy(draft.title);
  const freeMessageId = await publish(config.freeChannel, draft, copy, false);
  const premiumMessageId = await publish(config.premiumChannel, draft, copy, true);
  const { error } = await supabase.from(config.postsTable).insert({
    title: draft.title, description: copy.description, hashtags: copy.hashtags, cover_url: coverUrl,
    content_urls: contentUrls, free_link: draft.freeLink, premium_link: draft.premiumLink || null, direct_link: draft.directLink || null,
    telegram_message_ids: { free: freeMessageId || null, premium: premiumMessageId || null }, status: 'published', source: 'telegram_bot',
  });
  if (error) throw new Error(`Supabase insert failed: ${error.message}`);
  await ctx.reply(`Published successfully.\nImages: ${contentUrls.filter((x) => x.kind === 'image').length}\nVideos: ${contentUrls.filter((x) => x.kind === 'video').length}`);
  reset(ctx);
}

bot.use(session({ initial: (): SessionData => ({}) }));
bot.command('start', async (ctx) => { if (!ensureAdmin(ctx)) return; await ctx.reply('Welcome. Use /new to create a post. Use /cancel at any time.'); });
bot.command('cancel', async (ctx) => { if (!ensureAdmin(ctx)) return; reset(ctx); await ctx.reply('Cancelled.'); });
bot.command('new', async (ctx) => { if (!ensureAdmin(ctx)) return; ctx.session = { step: 'title', draft: { media: [] } }; await ctx.reply('Send the post title.'); });
bot.command('done', async (ctx) => { if (!ensureAdmin(ctx)) return; if (ctx.session.step !== 'media') { await ctx.reply('Use /new first, and send media before /done.'); return; } ctx.session.step = 'free'; await ctx.reply('Send the free link.'); });
bot.on('message:text', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  const value = ctx.message.text.trim(); const sessionData = ctx.session; const draft = sessionData.draft;
  if (!draft || !sessionData.step) { await ctx.reply('Use /new to start a post.'); return; }
  if (sessionData.step === 'title') { draft.title = value; sessionData.step = 'cover'; await ctx.reply('Send the cover picture (or type /skip).'); return; }
  if (sessionData.step === 'cover') { if (value === '/skip') { sessionData.step = 'media'; await ctx.reply('Send content images/videos one by one. When finished, send /done.'); } else await ctx.reply('Please send a picture or /skip.'); return; }
  if (sessionData.step === 'media') { await ctx.reply('Send an image/video, or /done when finished.'); return; }
  if (sessionData.step === 'free') { draft.freeLink = value; sessionData.step = 'premium'; await ctx.reply('Send the premium link, or /skip.'); return; }
  if (sessionData.step === 'premium') { if (value !== '/skip') draft.premiumLink = value; sessionData.step = 'direct'; await ctx.reply('Send the direct link, or /skip.'); return; }
  if (sessionData.step === 'direct') { if (value !== '/skip') draft.directLink = value; await finalize(ctx); }
});
bot.on('message', async (ctx) => {
  if (!ensureAdmin(ctx)) return;
  const sessionData = ctx.session; const draft = sessionData.draft; const item = mediaFromMessage(ctx);
  if (!draft || !sessionData.step || !item) { await ctx.reply('Use /new, then follow the prompts.'); return; }
  if (sessionData.step === 'cover') { draft.cover = item; sessionData.step = 'media'; await ctx.reply('Cover saved. Send content images/videos one by one. Send /done when finished.'); return; }
  if (sessionData.step === 'media') { if (draft.media.length >= config.maxMedia) { await ctx.reply(`Maximum ${config.maxMedia} media items reached. Send /done.`); return; } draft.media.push(item); await ctx.reply(`Saved ${item.kind} ${draft.media.length}/${config.maxMedia}. Send another or /done.`); return; }
  await ctx.reply('Please follow the current step shown above.');
});

bot.catch((error) => { const ctx = error.ctx; const cause = error.error; console.error(`Update ${ctx.update.update_id} failed`, cause); if (cause instanceof GrammyError) console.error(cause.description); else if (cause instanceof HttpError) console.error(cause); });

console.log('Telegram post bot starting…');
await bot.start({ onStart: (info) => console.log(`Bot @${info.username} is running in long-polling mode.`) });
