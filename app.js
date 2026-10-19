'use strict';

/* ------------------------------------------------------------------ *
 *  إعدادات عامة
 * ------------------------------------------------------------------ */
const API_BASE = 'https://generativelanguage.googleapis.com/v1beta';
const DEFAULT_MODEL = 'gemini-3.8-flash';
const MODELS = [
  { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash (موصى به)' },
  { id: 'gemini-flash-latest', label: 'Gemini Flash – أحدث إصدار تلقائياً' },
  { id: 'gemini-3.6-flash', label: 'Gemini 3.6 Flash' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash-Lite (أسرع وأخف)' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash-Lite' },
];
const LS = { key: 'aocr.apiKey', model: 'aocr.model', conc: 'aocr.concurrency' };

const MAX_SIDE = 2560;            // أقصى طول لضلع الصورة المرسلة
const MAX_RAW_BYTES = 3.5 * 1024 * 1024; // أصغر من هذا ونوعه مدعوم ← يُرسل كما هو
const DIRECT_MIME = ['image/png', 'image/jpeg', 'image/webp', 'image/heic', 'image/heif'];
const MAX_ATTEMPTS = 6;
const NO_TEXT = '[[NO_TEXT]]';
const NO_TEXT_LABEL = 'لا يوجد نص في هذه الصورة';

const SYSTEM_PROMPT = `You are a precise OCR engine. Transcribe ALL text visible in the image exactly as written.

Rules:
- Output the text verbatim. Do NOT translate, summarize, explain, comment, or correct spelling or grammar.
- Keep the natural reading order (Arabic right-to-left, top to bottom; for multi-column layouts read each column fully in order).
- Preserve line breaks and paragraph breaks as they appear.
- Preserve diacritics (tashkeel), punctuation, symbols, and emojis that are part of the text.
- Keep numbers exactly in the digit style shown (Arabic-Indic ٠١٢٣ or Western 0123).
- Keep English or other non-Arabic words exactly as they appear, in place.
- For tables, write each row on its own line with cells separated by " | ".
- If a word is unclear, write your best reading of it without any note.
- No introduction, no closing remarks, no Markdown formatting, no code fences.
- If the image contains no readable text at all, reply with exactly: ${NO_TEXT}`;

const USER_PROMPT = 'انسخ النص الموجود في هذه الصورة حرفياً.';

/* ------------------------------------------------------------------ *
 *  الحالة
 * ------------------------------------------------------------------ */
const state = {
  items: [],        // { id, file, name, url, status, text, error, prepared, controller, waitUntil }
  running: 0,
  blocked: false,   // يتوقف الطابور عند مفتاح غير صحيح أو انتهاء الحصة اليومية
  pasteCount: 0,
  nextId: 1,
};
const els = {};   // عناصر الصفحة
const cardEls = new Map(); // id -> عناصر البطاقة

const $ = (sel, root = document) => root.querySelector(sel);

/* ------------------------------------------------------------------ *
 *  التخزين المحلي (مع حماية من المتصفحات التي تمنعه)
 * ------------------------------------------------------------------ */
function lsGet(k, def = '') { try { return localStorage.getItem(k) ?? def; } catch { return def; } }
function lsSet(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch { /* تجاهل */ } }
const getKey = () => lsGet(LS.key).trim();
const getModel = () => lsGet(LS.model) || DEFAULT_MODEL;
const getConc = () => Math.min(3, Math.max(1, parseInt(lsGet(LS.conc, '2'), 10) || 2));

/* ------------------------------------------------------------------ *
 *  البداية
 * ------------------------------------------------------------------ */
document.addEventListener('DOMContentLoaded', init);

function init() {
  for (const id of ['dropzone', 'fileInput', 'toolbar', 'cards', 'progressText', 'progressSub', 'progressBar',
    'copyAllBtn', 'txtBtn', 'docxBtn', 'retryErrorsBtn', 'clearBtn', 'settingsBtn', 'settings', 'settingsForm',
    'keyInput', 'toggleKey', 'modelSelect', 'customModel', 'fetchModels', 'fetchModelsMsg', 'concSelect',
    'clearKey', 'keyBanner', 'lightbox', 'toast', 'cardTpl']) {
    els[id] = document.getElementById(id);
  }

  // إضافة الصور
  els.fileInput.addEventListener('change', () => { addFiles(els.fileInput.files); els.fileInput.value = ''; });
  els.dropzone.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); els.fileInput.click(); } });

  let dragDepth = 0;
  window.addEventListener('dragenter', e => { if (hasFiles(e)) { e.preventDefault(); dragDepth++; els.dropzone.classList.add('over'); } });
  window.addEventListener('dragleave', e => { if (hasFiles(e) && --dragDepth <= 0) { dragDepth = 0; els.dropzone.classList.remove('over'); } });
  window.addEventListener('dragover', e => { if (hasFiles(e)) e.preventDefault(); });
  window.addEventListener('drop', e => {
    if (!hasFiles(e)) return;
    e.preventDefault(); dragDepth = 0; els.dropzone.classList.remove('over');
    addFiles(e.dataTransfer.files);
  });

  document.addEventListener('paste', e => {
    const files = [...(e.clipboardData?.items || [])]
      .filter(it => it.kind === 'file')
      .map(it => it.getAsFile())
      .filter(Boolean);
    if (!files.length) return;
    // لا نمنع اللصق العادي للنص داخل مربعات النص
    e.preventDefault();
    addFiles(files.map(f => {
      if (f.name && f.name !== 'image.png') return f;
      state.pasteCount++;
      const ext = (f.type.split('/')[1] || 'png').replace('jpeg', 'jpg');
      return new File([f], `صورة ملصقة ${state.pasteCount}.${ext}`, { type: f.type });
    }));
  });

  // الأزرار العامة
  els.copyAllBtn.addEventListener('click', () => copyText(buildCombinedText(), els.copyAllBtn, 'تم نسخ الكل ✓'));
  els.txtBtn.addEventListener('click', downloadTxt);
  els.docxBtn.addEventListener('click', downloadDocx);
  els.retryErrorsBtn.addEventListener('click', () => {
    state.items.filter(i => i.status === 'error').forEach(i => requeue(i));
    pump();
  });
  els.clearBtn.addEventListener('click', clearAll);

  // الإعدادات
  els.settingsBtn.addEventListener('click', openSettings);
  document.querySelectorAll('[data-open-settings]').forEach(b => b.addEventListener('click', openSettings));
  setupSettings();

  // المكبّر
  setupLightbox();

  window.addEventListener('online', () => { if (state.items.some(i => i.status === 'queued')) pump(); });
  window.addEventListener('beforeunload', e => {
    if (state.items.some(i => i.status === 'working' || i.status === 'queued' || i.status === 'waiting')) {
      e.preventDefault(); e.returnValue = '';
    }
  });

  refreshUI();
}

function hasFiles(e) { return [...(e.dataTransfer?.types || [])].includes('Files'); }

/* ------------------------------------------------------------------ *
 *  إضافة الصور وإنشاء البطاقات
 * ------------------------------------------------------------------ */
function addFiles(fileList) {
  const files = [...(fileList || [])];
  if (!files.length) return;
  const images = files.filter(isImageFile);
  const rejected = files.length - images.length;
  if (rejected) toast(rejected === 1 ? 'تم تجاهل ملف واحد لأنه ليس صورة مدعومة.' : `تم تجاهل ${rejected} ملفات لأنها ليست صوراً مدعومة.`, true);

  // ترتيب الصور المختارة معاً حسب الاسم بترتيب طبيعي (1، 2، 10)
  images.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' }));

  for (const file of images) {
    const item = {
      id: state.nextId++, file, name: file.name || 'صورة',
      url: URL.createObjectURL(file), status: 'queued', text: '', error: '',
      prepared: null, controller: null, waitUntil: 0,
    };
    state.items.push(item);
    createCard(item);
  }
  refreshUI();
  pump();
  if (images.length && !getKey()) openSettings();
}

function isImageFile(f) {
  if (f.type && f.type.startsWith('image/')) return true;
  return /\.(png|jpe?g|webp|gif|bmp|heic|heif|avif|tiff?)$/i.test(f.name || '');
}

function createCard(item) {
  const node = els.cardTpl.content.firstElementChild.cloneNode(true);
  const c = {
    root: node,
    num: $('.num', node), fname: $('.fname', node), status: $('.status', node),
    thumb: $('.thumb', node), img: $('.thumb img', node), text: $('.text', node), err: $('.err', node),
    copy: $('.copy', node), redo: $('.redo', node), del: $('.del', node), count: $('.count', node),
  };
  c.fname.textContent = item.name;
  c.fname.title = item.name;
  c.img.src = item.url;
  c.img.alt = item.name;
  c.img.addEventListener('error', () => c.thumb.classList.add('noimg'), { once: true });
  c.thumb.addEventListener('click', () => openLightbox(item));
  c.text.addEventListener('input', () => { item.text = c.text.value; c.text.classList.remove('empty-result'); updateCount(item); autoGrow(c.text); });
  c.copy.addEventListener('click', () => copyText(c.text.value, c.copy, 'تم النسخ ✓'));
  c.redo.addEventListener('click', () => { requeue(item); pump(); });
  c.del.addEventListener('click', () => removeItem(item));
  cardEls.set(item.id, c);
  els.cards.appendChild(node);
  renderCard(item);
}

const STATUS_LABEL = {
  queued: 'في الانتظار',
  working: 'جارٍ الاستخراج',
  waiting: 'انتظار الحد…',
  done: 'تم',
  error: 'خطأ',
};

function renderCard(item) {
  const c = cardEls.get(item.id);
  if (!c) return;
  let label = STATUS_LABEL[item.status];
  if (item.status === 'waiting') {
    const s = Math.max(0, Math.ceil((item.waitUntil - Date.now()) / 1000));
    label = `إعادة المحاولة بعد ${s} ث`;
  }
  c.status.textContent = label;
  c.status.dataset.s = item.status;
  c.err.hidden = item.status !== 'error';
  c.err.textContent = item.error;
  const busy = item.status === 'working' || item.status === 'waiting';
  c.redo.disabled = busy || item.status === 'queued';
  c.copy.disabled = !c.text.value.trim();
  c.text.readOnly = busy;
  updateCount(item);
}

function updateCount(item) {
  const c = cardEls.get(item.id);
  if (!c) return;
  const t = c.text.classList.contains('empty-result') ? '' : c.text.value.trim();
  c.count.textContent = t ? `${t.split(/\s+/).length} كلمة` : '';
  c.copy.disabled = !c.text.value.trim();
}

function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight + 2, 520) + 'px';
}

function setResultText(item, text) {
  const c = cardEls.get(item.id);
  item.text = text;
  if (!c) return;
  if (text === NO_TEXT) {
    c.text.value = NO_TEXT_LABEL;
    c.text.classList.add('empty-result');
    item.text = '';
  } else {
    c.text.value = text;
    c.text.classList.remove('empty-result');
  }
  autoGrow(c.text);
}

function renumber() {
  state.items.forEach((item, i) => { const c = cardEls.get(item.id); if (c) c.num.textContent = i + 1; });
}

function requeue(item) {
  item.status = 'queued';
  item.error = '';
  renderCard(item);
  refreshUI();
}

function removeItem(item) {
  item.controller?.abort();
  const idx = state.items.indexOf(item);
  if (idx >= 0) state.items.splice(idx, 1);
  const c = cardEls.get(item.id);
  c?.root.remove();
  cardEls.delete(item.id);
  URL.revokeObjectURL(item.url);
  refreshUI();
  pump();
}

function clearAll() {
  if (!state.items.length) return;
  if (!confirm('هل تريد حذف كل الصور والنصوص والبدء من جديد؟')) return;
  for (const item of [...state.items]) {
    item.controller?.abort();
    URL.revokeObjectURL(item.url);
  }
  state.items = [];
  cardEls.clear();
  els.cards.innerHTML = '';
  state.pasteCount = 0;
  refreshUI();
}

function refreshUI() {
  const items = state.items;
  const total = items.length;
  const done = items.filter(i => i.status === 'done').length;
  const failed = items.filter(i => i.status === 'error').length;
  const active = items.filter(i => i.status === 'working' || i.status === 'waiting').length;
  const queued = items.filter(i => i.status === 'queued').length;

  document.body.classList.toggle('has-items', total > 0);
  els.toolbar.hidden = total === 0;
  els.keyBanner.hidden = !!getKey();
  renumber();

  els.progressText.textContent = total ? `تم ${done + failed} من ${total}` : '';
  const parts = [];
  if (active) parts.push(`قيد المعالجة: ${active}`);
  if (queued) parts.push(state.blocked || !getKey() ? `متوقفة: ${queued}` : `في الانتظار: ${queued}`);
  if (failed) parts.push(`فشلت: ${failed}`);
  els.progressSub.textContent = parts.join(' · ');
  els.progressBar.style.width = total ? `${((done + failed) / total) * 100}%` : '0';
  els.retryErrorsBtn.hidden = failed === 0;

  const anyText = items.some(i => i.text.trim());
  els.copyAllBtn.disabled = els.txtBtn.disabled = els.docxBtn.disabled = !anyText;
}

/* ------------------------------------------------------------------ *
 *  الطابور
 * ------------------------------------------------------------------ */
function pump() {
  if (state.blocked) { refreshUI(); return; }
  if (!getKey()) { refreshUI(); return; }
  const max = getConc();
  while (state.running < max) {
    const next = state.items.find(i => i.status === 'queued');
    if (!next) break;
    run(next);
  }
  refreshUI();
}

async function run(item) {
  state.running++;
  item.status = 'working';
  item.error = '';
  item.controller = new AbortController();
  renderCard(item);
  try {
    const text = await extract(item, item.controller.signal);
    if (!state.items.includes(item)) return;
    setResultText(item, text);
    item.status = 'done';
  } catch (err) {
    if (!state.items.includes(item) || err?.name === 'AbortError') return;
    if (err.code === 'BAD_KEY' || err.code === 'DAILY_QUOTA' || err.code === 'BAD_MODEL') {
      // مشكلة عامة: نعيد الصورة للطابور ونوقفه حتى يصلح المستخدم الإعدادات
      item.status = 'queued';
      if (!state.blocked) {
        state.blocked = true;
        toast(err.message, true);
        if (err.code !== 'DAILY_QUOTA') openSettings();
      }
    } else {
      item.status = 'error';
      item.error = err.message || 'حدث خطأ غير معروف.';
    }
  } finally {
    item.controller = null;
    state.running--;
    renderCard(item);
    refreshUI();
    pump();
  }
}

/* ------------------------------------------------------------------ *
 *  تجهيز الصورة (تصغير الكبيرة مع الحفاظ على وضوح النص)
 * ------------------------------------------------------------------ */
async function prepareImage(file) {
  const type = (file.type || '').toLowerCase();
  let dims = null;
  let bitmap = null;
  try {
    bitmap = await createImageBitmap(file);
    dims = { w: bitmap.width, h: bitmap.height };
  } catch { /* بعض الصيغ (مثل HEIC) لا يفتحها المتصفح */ }

  const direct = DIRECT_MIME.includes(type);
  const smallEnough = file.size <= MAX_RAW_BYTES && (!dims || Math.max(dims.w, dims.h) <= MAX_SIDE);

  if (direct && (smallEnough || !bitmap)) {
    bitmap?.close?.();
    if (file.size > 15 * 1024 * 1024) throw userError('حجم الصورة كبير جداً (أكثر من 15 ميغابايت) ولا يمكن تصغيرها في هذا المتصفح.');
    return { mime: type, data: await blobToBase64(file) };
  }
  if (!bitmap) throw userError('صيغة الصورة غير مدعومة. جرّب حفظها بصيغة PNG أو JPG.');

  const scale = Math.min(1, MAX_SIDE / Math.max(dims.w, dims.h));
  const w = Math.round(dims.w * scale);
  const h = Math.round(dims.h * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, w, h);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, w, h);
  bitmap.close?.();
  const blob = await new Promise(r => canvas.toBlob(r, 'image/jpeg', 0.92));
  if (!blob) throw userError('تعذّر تجهيز الصورة.');
  return { mime: 'image/jpeg', data: await blobToBase64(blob) };
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(',')[1]);
    r.onerror = () => reject(userError('تعذّرت قراءة الملف.'));
    r.readAsDataURL(blob);
  });
}

/* ------------------------------------------------------------------ *
 *  الاتصال بـ Gemini
 * ------------------------------------------------------------------ */
function userError(message, code) { const e = new Error(message); if (code) e.code = code; return e; }

async function extract(item, signal) {
  if (!item.prepared) item.prepared = await prepareImage(item.file);
  const { mime, data } = item.prepared;
  const model = getModel();
  const key = getKey();

  const body = {
    system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ inline_data: { mime_type: mime, data } }, { text: USER_PROMPT }] }],
    generationConfig: { maxOutputTokens: 8192 },
  };
  // تقليل "التفكير" يسرّع النسخ الحرفي؛ النماذج القديمة لا تدعم هذا الخيار فنحذفه إن رُفض
  if (!/gemini-(1|2)\./.test(model)) body.generationConfig.thinkingConfig = { thinkingLevel: 'low' };

  let netFailures = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    let res;
    try {
      res = await fetch(`${API_BASE}/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify(body),
        signal,
      });
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      netFailures++;
      if (netFailures >= 3) throw userError(navigator.onLine === false
        ? 'لا يوجد اتصال بالإنترنت. تحقق من الاتصال ثم اضغط "إعادة الاستخراج".'
        : 'تعذّر الاتصال بخدمة Gemini. تحقق من الإنترنت ثم أعد المحاولة.');
      await waitFor(item, 3000 * netFailures, signal);
      attempt--;
      continue;
    }

    if (res.ok) return parseResponse(await res.json());

    const payload = await res.json().catch(() => ({}));
    const msg = payload?.error?.message || '';
    const reason = JSON.stringify(payload?.error?.details || '');

    if (res.status === 400 && body.generationConfig.thinkingConfig && /think/i.test(msg)) {
      delete body.generationConfig.thinkingConfig;
      attempt--;
      continue;
    }
    if (/API_KEY_INVALID|API key not valid|API key expired/i.test(msg + reason)) {
      throw userError('مفتاح Gemini غير صحيح أو منتهي. تأكد من نسخه كاملاً في الإعدادات.', 'BAD_KEY');
    }
    if (res.status === 403) {
      throw userError('المفتاح لا يملك صلاحية استخدام Gemini API. أنشئ مفتاحاً جديداً من Google AI Studio.', 'BAD_KEY');
    }
    if (res.status === 404) {
      throw userError(`النموذج "${model}" غير متاح لمفتاحك. اختر نموذجاً آخر من الإعدادات.`, 'BAD_MODEL');
    }
    if (res.status === 429) {
      if (/per ?day|PerDay|daily/i.test(msg + reason)) {
        throw userError('انتهت حصة اليوم المجانية لهذا النموذج. جرّب نموذجاً آخر من الإعدادات (مثل Flash-Lite) أو عُد غداً.', 'DAILY_QUOTA');
      }
      if (attempt === MAX_ATTEMPTS) throw userError('تم تجاوز حد الطلبات أكثر من مرة. انتظر دقيقة ثم اضغط "إعادة الاستخراج".');
      await waitFor(item, retryDelayMs(payload, attempt), signal);
      continue;
    }
    if (res.status >= 500) {
      if (attempt === MAX_ATTEMPTS) throw userError('خدمة Gemini مشغولة حالياً. أعد المحاولة بعد قليل.');
      await waitFor(item, Math.min(30000, 2000 * 2 ** (attempt - 1)), signal);
      continue;
    }
    if (res.status === 400 && /image|mime|inline_data|Unable to process/i.test(msg)) {
      throw userError('لم تتمكن Gemini من قراءة هذه الصورة. جرّب حفظها بصيغة PNG أو JPG.');
    }
    throw userError(`خطأ من Gemini (${res.status})${msg ? ': ' + msg : ''}`);
  }
  throw userError('تعذّر استخراج النص بعد عدة محاولات.');
}

function retryDelayMs(payload, attempt) {
  const info = (payload?.error?.details || []).find(d => String(d['@type'] || '').includes('RetryInfo'));
  const secs = info ? parseFloat(String(info.retryDelay).replace('s', '')) : NaN;
  if (Number.isFinite(secs) && secs > 0) return Math.min(90, secs + 1) * 1000;
  return Math.min(60000, 5000 * 2 ** (attempt - 1));
}

function waitFor(item, ms, signal) {
  item.status = 'waiting';
  item.waitUntil = Date.now() + ms;
  renderCard(item);
  refreshUI();
  return new Promise((resolve, reject) => {
    const tick = setInterval(() => renderCard(item), 1000);
    const t = setTimeout(done, ms);
    function done() {
      clearInterval(tick); clearTimeout(t);
      signal?.removeEventListener('abort', onAbort);
      if (item.status === 'waiting') { item.status = 'working'; renderCard(item); refreshUI(); }
      resolve();
    }
    function onAbort() { clearInterval(tick); clearTimeout(t); reject(new DOMException('aborted', 'AbortError')); }
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function parseResponse(json) {
  const cand = json?.candidates?.[0];
  if (!cand) {
    const block = json?.promptFeedback?.blockReason;
    throw userError(block ? 'رفضت Gemini معالجة هذه الصورة لأسباب تتعلق بسياسة المحتوى.' : 'لم تُرجع Gemini أي نتيجة.');
  }
  const text = (cand.content?.parts || [])
    .filter(p => typeof p.text === 'string' && !p.thought)
    .map(p => p.text).join('');
  let out = cleanText(text);
  if (!out) {
    if (cand.finishReason === 'SAFETY' || cand.finishReason === 'PROHIBITED_CONTENT') throw userError('رفضت Gemini معالجة هذه الصورة لأسباب تتعلق بسياسة المحتوى.');
    if (cand.finishReason === 'RECITATION') throw userError('امتنعت Gemini عن نسخ هذا النص لأنه محمي بحقوق نشر.');
    return NO_TEXT;
  }
  if (out.replace(/\s/g, '') === NO_TEXT) return NO_TEXT;
  if (cand.finishReason === 'MAX_TOKENS') out += '\n…';
  return out;
}

function cleanText(t) {
  let s = String(t || '').replace(/\r\n/g, '\n').trim();
  // إزالة أسوار الشيفرة إن أضافها النموذج رغم التعليمات
  const fence = s.match(/^```[a-z]*\n([\s\S]*?)\n?```$/i);
  if (fence) s = fence[1].trim();
  return s;
}

/* ------------------------------------------------------------------ *
 *  النسخ والتصدير
 * ------------------------------------------------------------------ */
function sections() {
  return state.items.map((item, i) => {
    const c = cardEls.get(item.id);
    let body = c && !c.text.classList.contains('empty-result') ? c.text.value.trim() : '';
    if (!body) body = item.status === 'done' ? `(${NO_TEXT_LABEL})` : item.status === 'error' ? '(فشل الاستخراج)' : '(لم يُستخرج بعد)';
    return { title: `— صورة ${i + 1}: ${item.name} —`, body };
  });
}

function buildCombinedText() {
  return sections().map(s => `${s.title}\n${s.body}`).join('\n\n');
}

async function copyText(text, btn, okLabel) {
  if (!text.trim()) return;
  let ok = false;
  try { await navigator.clipboard.writeText(text); ok = true; } catch {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { ok = document.execCommand('copy'); } catch { ok = false; }
    ta.remove();
  }
  if (!ok) { toast('تعذّر النسخ. حدّد النص وانسخه يدوياً.', true); return; }
  const original = btn.textContent;
  btn.textContent = okLabel;
  btn.classList.add('copied');
  clearTimeout(btn._t);
  btn._t = setTimeout(() => { btn.textContent = original; btn.classList.remove('copied'); }, 1500);
}

function fileStamp() {
  const d = new Date();
  const p = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function downloadBlob(blob, name) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function downloadTxt() {
  // BOM لكي يعرض المفكرة (Notepad) العربية بشكل صحيح
  const blob = new Blob(['﻿' + buildCombinedText().replace(/\n/g, '\r\n')], { type: 'text/plain;charset=utf-8' });
  downloadBlob(blob, `نصوص-الصور_${fileStamp()}.txt`);
}

const xmlEsc = s => s.replace(/[&<>"]/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[ch]))
  // إزالة محارف التحكم غير المسموحة في XML
  .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');

function docxParagraph(text, { bold = false, size = 28, spaceAfter = 0, color } = {}) {
  const rPr = `<w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial" w:cs="Arial"/>${bold ? '<w:b/><w:bCs/>' : ''}${color ? `<w:color w:val="${color}"/>` : ''}<w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr>`;
  const run = text ? `<w:r>${rPr}<w:t xml:space="preserve">${xmlEsc(text)}</w:t></w:r>` : '';
  return `<w:p><w:pPr><w:bidi/><w:spacing w:after="${spaceAfter}" w:line="360" w:lineRule="auto"/>${rPr}</w:pPr>${run}</w:p>`;
}

async function downloadDocx() {
  if (!window.JSZip) { downloadDocFallback(); return; }
  const paras = [];
  paras.push(docxParagraph('النصوص المستخرجة من الصور', { bold: true, size: 36, spaceAfter: 240 }));
  for (const s of sections()) {
    paras.push(docxParagraph(s.title, { bold: true, size: 28, spaceAfter: 120, color: '0F766E' }));
    for (const line of s.body.split('\n')) paras.push(docxParagraph(line));
    paras.push(docxParagraph('', { spaceAfter: 240 }));
  }
  const documentXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join('')}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1200" w:right="1200" w:bottom="1200" w:left="1200" w:header="708" w:footer="708" w:gutter="0"/><w:bidi/></w:sectPr></w:body></w:document>`;

  const zip = new JSZip();
  const opt = { createFolders: false };
  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`, opt);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`, opt);
  zip.file('word/document.xml', documentXml, opt);
  const blob = await zip.generateAsync({ type: 'blob', mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
  downloadBlob(blob, `نصوص-الصور_${fileStamp()}.docx`);
}

function downloadDocFallback() {
  const html = sections().map(s => `<h3 style="color:#0f766e">${xmlEsc(s.title)}</h3><p>${xmlEsc(s.body).replace(/\n/g, '<br>')}</p>`).join('');
  const doc = `<html xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:w="urn:schemas-microsoft-com:office:word"><head><meta charset="utf-8"></head><body dir="rtl" style="font-family:Arial;font-size:14pt">${html}</body></html>`;
  downloadBlob(new Blob(['﻿' + doc], { type: 'application/msword' }), `نصوص-الصور_${fileStamp()}.doc`);
}

/* ------------------------------------------------------------------ *
 *  نافذة الإعدادات
 * ------------------------------------------------------------------ */
function fillModelOptions(extra = []) {
  const current = getModel();
  const list = [...MODELS];
  for (const id of extra) if (!list.some(m => m.id === id)) list.push({ id, label: id });
  els.modelSelect.innerHTML = '';
  for (const m of list) els.modelSelect.add(new Option(m.label, m.id));
  els.modelSelect.add(new Option('نموذج آخر (اكتب اسمه)…', '__custom'));
  if (list.some(m => m.id === current)) {
    els.modelSelect.value = current;
    els.customModel.hidden = true;
  } else {
    els.modelSelect.value = '__custom';
    els.customModel.hidden = false;
    els.customModel.value = current;
  }
}

function setupSettings() {
  fillModelOptions();
  els.modelSelect.addEventListener('change', () => {
    els.customModel.hidden = els.modelSelect.value !== '__custom';
    if (!els.customModel.hidden) els.customModel.focus();
  });
  els.toggleKey.addEventListener('click', () => {
    const show = els.keyInput.type === 'password';
    els.keyInput.type = show ? 'text' : 'password';
    els.toggleKey.textContent = show ? 'إخفاء' : 'إظهار';
  });
  els.clearKey.addEventListener('click', () => {
    if (!getKey() && !els.keyInput.value) return;
    if (!confirm('حذف المفتاح المحفوظ من هذا المتصفح؟')) return;
    lsSet(LS.key, '');
    els.keyInput.value = '';
    refreshUI();
    toast('تم حذف المفتاح.');
  });
  els.fetchModels.addEventListener('click', fetchModelList);
  document.getElementById('cancelSettings').addEventListener('click', () => els.settings.close('cancel'));

  els.settings.addEventListener('close', () => {
    if (els.settings.returnValue !== 'save') return;
    const key = els.keyInput.value.trim();
    lsSet(LS.key, key);
    let model = els.modelSelect.value === '__custom' ? els.customModel.value.trim() : els.modelSelect.value;
    model = model.replace(/^models\//, '') || DEFAULT_MODEL;
    lsSet(LS.model, model);
    lsSet(LS.conc, els.concSelect.value);
    state.blocked = false;
    if (key && state.items.some(i => i.status === 'queued')) toast('تم الحفظ، بدأ الاستخراج.');
    else toast('تم حفظ الإعدادات.');
    pump();
  });
}

function openSettings() {
  els.keyInput.value = getKey();
  els.keyInput.type = 'password';
  els.toggleKey.textContent = 'إظهار';
  els.concSelect.value = String(getConc());
  els.fetchModelsMsg.textContent = '';
  fillModelOptions();
  els.settings.returnValue = '';
  if (!els.settings.open) els.settings.showModal();
  if (!els.keyInput.value) els.keyInput.focus();
}

async function fetchModelList() {
  const key = els.keyInput.value.trim();
  if (!key) { els.fetchModelsMsg.textContent = 'أدخل المفتاح أولاً.'; return; }
  els.fetchModelsMsg.textContent = 'جارٍ الجلب…';
  try {
    const res = await fetch(`${API_BASE}/models?pageSize=200`, { headers: { 'x-goog-api-key': key } });
    if (!res.ok) {
      els.fetchModelsMsg.textContent = res.status === 400 || res.status === 403 ? 'المفتاح غير صحيح.' : `فشل الجلب (${res.status}).`;
      return;
    }
    const json = await res.json();
    const ids = (json.models || [])
      .filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
      .map(m => m.name.replace(/^models\//, ''))
      .filter(id => /^gemini-.*flash/i.test(id) && !/tts|audio|image|live|embedding/i.test(id));
    const selected = els.modelSelect.value;
    const custom = els.customModel.value;
    fillModelOptions(ids);
    if ([...els.modelSelect.options].some(o => o.value === selected)) els.modelSelect.value = selected;
    els.customModel.hidden = els.modelSelect.value !== '__custom';
    els.customModel.value = custom;
    els.fetchModelsMsg.textContent = `المفتاح يعمل ✓ (${ids.length} نموذج Flash)`;
  } catch {
    els.fetchModelsMsg.textContent = 'تعذّر الاتصال. تحقق من الإنترنت.';
  }
}

/* ------------------------------------------------------------------ *
 *  المكبّر
 * ------------------------------------------------------------------ */
function setupLightbox() {
  const lb = els.lightbox;
  const img = $('img', lb);
  $('.lb-close', lb).addEventListener('click', closeLightbox);
  lb.addEventListener('click', e => { if (e.target === lb || e.target.classList.contains('lb-stage')) closeLightbox(); });
  img.addEventListener('click', e => {
    const zoomed = lb.classList.toggle('zoomed');
    if (zoomed) {
      // تمرير المكبّر إلى موضع الضغطة تقريباً
      const stage = $('.lb-stage', lb);
      const r = img.getBoundingClientRect();
      const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
      requestAnimationFrame(() => {
        stage.scrollLeft = fx * img.scrollWidth - stage.clientWidth / 2;
        stage.scrollTop = fy * img.scrollHeight - stage.clientHeight / 2;
      });
    }
  });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !lb.hidden) closeLightbox(); });
}

function openLightbox(item) {
  const lb = els.lightbox;
  const idx = state.items.indexOf(item);
  $('.lb-caption', lb).textContent = `صورة ${idx + 1}: ${item.name}`;
  $('img', lb).src = item.url;
  lb.classList.remove('zoomed');
  lb.hidden = false;
  document.body.style.overflow = 'hidden';
}

function closeLightbox() {
  els.lightbox.hidden = true;
  document.body.style.overflow = '';
}

/* ------------------------------------------------------------------ *
 *  رسائل قصيرة
 * ------------------------------------------------------------------ */
function toast(msg, isError = false) {
  const t = els.toast;
  t.textContent = msg;
  t.classList.toggle('error', isError);
  t.hidden = false;
  clearTimeout(t._t);
  t._t = setTimeout(() => { t.hidden = true; }, isError ? 5000 : 2500);
}
