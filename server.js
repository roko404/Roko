const express = require('express');
const path = require('path');
const cheerio = require('cheerio');

const app = express();
app.use(express.json({ limit: '15mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Free web search (DuckDuckGo, no API key needed) ----------
async function webSearch(query) {
  if (!query || !query.trim()) return [];
  try {
    const url = 'https://lite.duckduckgo.com/lite/?q=' + encodeURIComponent(query);
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const html = await response.text();
    const $ = cheerio.load(html);
    const results = [];

    $('a').each((i, el) => {
      if (results.length >= 5) return;
      const cls = $(el).attr('class') || '';
      if (cls.includes('result-link')) {
        const title = $(el).text().trim();
        const link = $(el).attr('href');
        if (title && link) results.push({ title, link, snippet: '' });
      }
    });
    $('.result-snippet').each((i, el) => {
      if (results[i]) results[i].snippet = $(el).text().trim();
    });
    return results;
  } catch (err) {
    console.error('web search failed:', err.message);
    return [];
  }
}

// ---------- Chat endpoint (Google Gemini free tier) ----------
app.post('/api/chat', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'সার্ভারে GEMINI_API_KEY সেট করা নেই। Secrets/Environment Variables চেক করো।' });
    }
    const { messages, lastUserMessage, context, image } = req.body;
    if (!Array.isArray(messages)) {
      return res.status(400).json({ error: 'messages ঠিকমতো পাঠানো হয়নি।' });
    }

    const searchResults = await webSearch(lastUserMessage || '');
    const searchContext = searchResults.length
      ? searchResults.map((r, i) => `[${i + 1}] ${r.title} — ${r.snippet} (উৎস: ${r.link})`).join('\n')
      : 'কোনো প্রাসঙ্গিক সার্চ ফলাফল পাওয়া যায়নি — নিজের জ্ঞান থেকে উত্তর দাও।';

    const systemPrompt = `তুমি "Roko" — একজন বাংলা ভাষার ব্যক্তিগত AI সহকারী। তুমি বিশেষভাবে বাংলাদেশের আইন এবং টেক্সটাইল/পোশাক শিল্প বিষয়ে প্রশ্নে দক্ষ, তবে যেকোনো বিষয়েই সাহায্য করো।
নিয়মাবলী:
- সবসময় বাংলায়, স্পষ্ট ও সংক্ষিপ্তভাবে উত্তর দাও।
- ব্যবহারকারীর কথায় লুকানো আবেগ (দুশ্চিন্তা, তাড়াহুড়ো, হতাশা ইত্যাদি) খেয়াল করে সহানুভূতিশীল সুরে উত্তর দাও, কিন্তু জোর করে কারো মানসিক অবস্থা নির্ণয় করো না।
- আইনি প্রশ্নে সাধারণ ও নির্ভরযোগ্য তথ্য দাও, কিন্তু নির্দিষ্ট মামলা/সমস্যার ক্ষেত্রে একজন আইনজীবীর সাথে কথা বলার পরামর্শ দিও — এটা আইনি পরামর্শের বিকল্প না।
- নিচে সাম্প্রতিক ইন্টারনেট সার্চের ফলাফল দেওয়া হলো, প্রাসঙ্গিক হলে ব্যবহার করে উত্তর দাও এবং উৎস উল্লেখ করো, অপ্রাসঙ্গিক হলে উপেক্ষা করো:
${searchContext}
${context ? `\nব্যবহারকারীর বর্তমান কাজ ও নোট: ${context}` : ''}`;

    const contents = messages.map(m => ({
      role: m.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: m.content }]
    }));

    // ইউজার ছবি আপলোড করলে (image = {mimeType, data(base64)}) সেটা সর্বশেষ user turn-এ inlineData হিসেবে জুড়ে দেওয়া হচ্ছে,
    // যাতে Gemini ছবিটা বিশ্লেষণ করে টেক্সটের সাথে মিলিয়ে উত্তর দিতে পারে।
    if (image && image.data && image.mimeType) {
      for (let i = contents.length - 1; i >= 0; i--) {
        if (contents[i].role === 'user') {
          contents[i].parts.push({ inlineData: { mimeType: image.mimeType, data: image.data } });
          break;
        }
      }
    }

    // 'gemini-flash-latest' একটা অ্যালিয়াস — Google নিজে থেকেই এটাকে সবসময়
    // সর্বশেষ স্টেবল Flash মডেলের সাথে যুক্ত রাখে, তাই বারবার মডেল বদলাতে হবে না।
    // যদি কোনো কারণে এই অ্যালিয়াসও কাজ না করে, নিচের fallbackModels থেকে চেষ্টা করা হবে।
    const primaryModel = 'gemini-flash-latest';
    const fallbackModels = ['gemini-2.5-flash', 'gemini-2.5-flash-lite'];

    async function callGemini(modelName) {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemPrompt }] },
            contents
          })
        }
      );
      const d = await r.json();
      return { ok: r.ok, status: r.status, data: d };
    }

    let { ok, status, data } = await callGemini(primaryModel);

    // primary মডেল ব্যর্থ হলে (যেমন "no longer available" এরর) fallback মডেলগুলো একে একে চেষ্টা করা হবে
    if (!ok) {
      console.error(`Gemini API error (${primaryModel}):`, data);
      for (const fb of fallbackModels) {
        const retry = await callGemini(fb);
        if (retry.ok) {
          ok = true; status = retry.status; data = retry.data;
          break;
        }
        console.error(`Gemini API error (${fb}):`, retry.data);
      }
    }

    if (!ok) {
      return res.status(status).json({ error: data.error?.message || 'AI থেকে উত্তর পাওয়া যায়নি।' });
    }

    const text = data.candidates?.[0]?.content?.parts?.map(p => p.text).join('\n').trim()
      || 'দুঃখিত, উত্তর তৈরি করতে সমস্যা হয়েছে।';

    res.json({ text, searched: searchResults.length > 0 });
  } catch (err) {
    console.error('Server error:', err);
    res.status(500).json({ error: 'সার্ভারে সমস্যা হয়েছে। একটু পর আবার চেষ্টা করো।' });
  }
});

// ---------- ছবি তৈরি (Gemini নেটিভ ইমেজ মডেল, ওরফে "Nano Banana") ----------
app.post('/api/generate-image', async (req, res) => {
  try {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(500).json({ error: 'সার্ভারে GEMINI_API_KEY সেট করা নেই।' });
    }
    const { prompt } = req.body;
    if (!prompt || !prompt.trim()) {
      return res.status(400).json({ error: 'ছবির বর্ণনা লেখো।' });
    }

    // gemini-2.5-flash-image সবচেয়ে স্থিতিশীল/প্রমাণিত ইমেজ মডেল; কাজ না করলে নতুন 3.1 ভার্সন চেষ্টা করা হবে।
    const primaryModel = 'gemini-2.5-flash-image';
    const fallbackModels = ['gemini-3.1-flash-image', 'gemini-2.5-flash-image-preview'];

    async function callImageModel(modelName) {
      const r = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${apiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
          })
        }
      );
      const d = await r.json();
      return { ok: r.ok, status: r.status, data: d };
    }

    let { ok, status, data } = await callImageModel(primaryModel);
    if (!ok) {
      console.error(`Image API error (${primaryModel}):`, data);
      for (const fb of fallbackModels) {
        const retry = await callImageModel(fb);
        if (retry.ok) { ok = true; status = retry.status; data = retry.data; break; }
        console.error(`Image API error (${fb}):`, retry.data);
      }
    }
    if (!ok) {
      return res.status(status).json({ error: data.error?.message || 'ছবি তৈরি করা যায়নি।' });
    }

    const parts = data.candidates?.[0]?.content?.parts || [];
    const imagePart = parts.find(p => p.inlineData);
    const textPart = parts.find(p => p.text)?.text || '';

    if (!imagePart) {
      return res.status(502).json({ error: 'মডেল কোনো ছবি ফেরত দেয়নি। প্রম্পট বদলে আবার চেষ্টা করো।' });
    }

    res.json({
      mimeType: imagePart.inlineData.mimeType || 'image/png',
      data: imagePart.inlineData.data,
      caption: textPart
    });
  } catch (err) {
    console.error('Image generation error:', err);
    res.status(500).json({ error: 'সার্ভারে সমস্যা হয়েছে। একটু পর আবার চেষ্টা করো।' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Roko চলছে -> পোর্ট ' + PORT));
