# ML Quest Master 🎯⚡

แอปเรียน Machine Learning แบบ **เควสรายวัน** — เปิดแอปแล้ว Gemini สร้างเควสวันนี้ให้, กดทำเสร็จเพื่อเก็บ XP/streak, และถาม **Quest Coach** ได้ตลอด

- **Frontend:** `index.html` ไฟล์เดียว (Tailwind CDN + Vanilla JS)
- **Backend:** Netlify Functions (`generate-quest.js`, `chat.js`)
- **Database:** Supabase (`progress`, `chat_history`)
- **AI:** Gemini 2.0 Flash

## โครงสร้างโปรเจค
```
ml-quest/
├── index.html
├── netlify.toml
├── supabase-schema.sql
├── .env.example
└── netlify/
    └── functions/
        ├── generate-quest.js
        └── chat.js
```

## ติดตั้ง

### 1) Supabase
1. สร้างโปรเจคที่ https://supabase.com
2. เปิด **SQL Editor** → รันไฟล์ `supabase-schema.sql`
3. คัดลอก **Project URL** และ **anon public key** จาก Settings → API

### 2) Gemini API key
ขอที่ https://aistudio.google.com/app/apikey

### 3) Environment variables
ตั้งค่าใน Netlify (Site settings → Environment variables) หรือไฟล์ `.env` สำหรับ local:
```
GEMINI_API_KEY=...
SUPABASE_URL=https://xxxx.supabase.co
SUPABASE_ANON_KEY=...
```

## รัน local
```bash
npm i -g netlify-cli
cd ml-quest
netlify dev
```
เปิด http://localhost:8888

## Deploy
ลาก folder ขึ้น Netlify หรือ `netlify deploy --prod` (อย่าลืมตั้ง env vars บน Netlify)

## การทำงาน

**`generate-quest.js`**
- `GET` → ดึง progress ล่าสุด, ถ้ามีเควส `pending` ของวันนี้คืนอันเดิม, ไม่งั้นให้ Gemini สร้างเควสใหม่ (JSON: title, description, objectives, tags, difficulty, time_minutes, xp) แล้วบันทึกลง Supabase → คืน `quest`, `day`, `phase`, `stats`
- `POST {action:"complete"|"skip", progressId}` → อัปเดต status (+XP เมื่อ complete) คืน `stats` ล่าสุด
  *(รวม action ไว้ในฟังก์ชันนี้เพื่อไม่ต้องเปิด anon key สู่ frontend)*

**`chat.js`**
- `POST {question, questContext, history, progressId}` → ให้ Gemini ตอบเป็น Quest Coach **ภาษาไทย** กระชับ มีโค้ดเมื่อจำเป็น และบันทึกลง `chat_history`

## หลักสูตร (phase)
1. Foundations · 2. Core ML · 3. Deep Learning · 4. Advanced & MLOps
(`day` เพิ่มทีละ 1 ต่อเควส, phase คำนวณจาก `day` ใน `generate-quest.js` — ปรับจำนวนวันได้ที่ `PHASES`)
