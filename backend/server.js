const express = require('express');
const cors = require('cors');
const multer = require('multer');
const pdfParse = require('pdf-parse');
require('dotenv').config();

if (!process.env.GEMINI_API_KEY) {
  console.warn('⚠️ GEMINI_API_KEY not set. Gemini requests will fail. Set GEMINI_API_KEY in your .env');
}

const { GoogleGenerativeAI } = require('@google/generative-ai');

const app = express();
app.use(cors());
app.use(express.json());

// Use memory storage so uploaded PDF buffer is available and limit file size to 5MB
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// Gemini setup
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-flash-latest" });
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS) || 30000; // default 30s

// Health check
app.get('/', (req, res) => res.send('Backend running ✅'));

// Check connectivity for several Gemini model names
app.get('/check-models', async (req, res) => {
  console.log('🔎 /check-models called');
  const modelsToCheck = [
    'gemini-1.5-pro',
    'gemini-1.5-flash',
    'gemini-flash-latest',
    'gemini-1.0-pro',
    'gemini-pro',
    'gemini-pro-vision'
  ];

  const results = [];
  for (const name of modelsToCheck) {
    try {
      const m = genAI.getGenerativeModel({ model: name });
      const result = await Promise.race([
        m.generateContent('Ping'),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), GEMINI_TIMEOUT_MS))
      ]);

      let info = '';
      if (typeof result === 'string') info = result;
      else if (result?.response?.text) info = typeof result.response.text === 'function' ? result.response.text() : result.response.text;
      else if (result?.outputText) info = result.outputText;
      else info = JSON.stringify(result);

      results.push({ model: name, ok: true, info: String(info).slice(0, 300) });
    } catch (err) {
      console.error(`Model ${name} check failed:`, err.message);
      results.push({ model: name, ok: false, error: err.message });
    }
  }

  res.json({ results });
});

// Model connectivity check
app.get('/check-model', async (req, res) => {
  console.log('🔎 Checking Gemini model connectivity...');
  try {
    const result = await Promise.race([
      model.generateContent('Ping'),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Model check timeout')), GEMINI_TIMEOUT_MS))
    ]);
    let info = '';
    if (typeof result === 'string') info = result;
    else if (result?.response?.text) info = typeof result.response.text === 'function' ? result.response.text() : result.response.text;
    else if (result?.outputText) info = result.outputText;
    else info = JSON.stringify(result);

    res.json({ status: 'ok', info: String(info).slice(0, 1000) });
  } catch (err) {
    console.error('❌ Model check failed:', err);
    res.status(502).json({ status: 'error', message: err.message });
  }
});

// List available models for the current API key
app.get('/list-models', async (req, res) => {
  console.log('🔎 Listing available models...');
  try {
    if (typeof genAI.listModels === 'function') {
      const list = await genAI.listModels();
      return res.json(list);
    }

    // Fallback: call Google API directly using api key via query param
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return res.status(400).json({ error: 'GEMINI_API_KEY not set' });

    const fetch = globalThis.fetch || (await import('node-fetch')).default;
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`);
    const body = await r.json();
    res.json(body);
  } catch (err) {
    console.error('❌ List models failed:', err);
    res.status(502).json({ status: 'error', message: err.message });
  }
});

// Analyze plain text (bypass PDF) - useful for testing and debugging
app.post('/analyze-text', async (req, res) => {
  try {
    console.log('➡️ Analyze-text request received');
    const resumeText = (req.body.resumeText || '').substring(0, 4000);
    const jobDescription = (req.body.jobDescription || '').substring(0, 3000);
    if (!resumeText || !jobDescription) {
      return res.status(400).json({ error: 'resumeText and jobDescription required' });
    }

    const prompt = `
You are an ATS Resume Analyzer.

Analyze the resume against the job description.
Respond ONLY with valid JSON.

{
  "atsScore": 0,
  "matchedSkills": [],
  "missingSkills": [],
  "improvements": []
}

RESUME:
${resumeText}

JOB DESCRIPTION:
${jobDescription}
`;

    console.log('⏳ Sending request to Gemini (text)...');

    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise((_, reject) => setTimeout(() => reject(new Error('Gemini timeout')), GEMINI_TIMEOUT_MS))
    ]);

    let raw = '';
    if (typeof result === 'string') raw = result;
    else if (result?.response?.text) raw = typeof result.response.text === 'function' ? result.response.text() : result.response.text;
    else if (result?.outputText) raw = result.outputText;
    else if (result?.outputs && result.outputs[0]) raw = JSON.stringify(result.outputs[0]);
    else raw = String(result);

    raw = raw.replace(/```json|```/g, '').trim();

    console.log('✅ Gemini responded (text)');

    let analysis;
    try {
      analysis = JSON.parse(raw);
    } catch (e) {
      const m = raw.match(/{[\s\S]*}/);
      console.error('Raw AI response (truncated):', raw.substring(0, 2000));
      if (m) {
        try {
          analysis = JSON.parse(m[0]);
        } catch (err2) {
          throw new Error('Failed to parse AI response as JSON');
        }
      } else {
        throw new Error('Failed to parse AI response as JSON');
      }
    }

    res.json(analysis);
  } catch (error) {
    console.error('🔥 ERROR (analyze-text):', error);
    res.status(500).json({
      atsScore: 50,
      matchedSkills: ['Basic resume structure detected'],
      missingSkills: ['Unable to fully analyze (AI timeout)'],
      improvements: ['Retry analysis', 'Use shorter resume', 'Ensure text-based PDF'],
      error: error.message
    });
  }
});

// Original analyze route follows
app.post('/analyze', upload.single('resume'), async (req, res) => {
  try {
    console.log("➡️ Analyze request received");

    if (!req.file || !req.body.jobDescription) {
      return res.status(400).json({ error: "Resume and Job Description required" });
    }

    // Extract resume text properly using pdf-parse
    const pdfData = await pdfParse(req.file.buffer);
    let resumeText = (pdfData && pdfData.text) ? pdfData.text : "";
    // Limit input size to avoid Gemini hang
    resumeText = resumeText.substring(0, 4000);
    const jobDescription = (req.body.jobDescription || "").substring(0, 3000);

    const prompt = `
You are an ATS Resume Analyzer.

Analyze the resume against the job description.
Respond ONLY with valid JSON.

{
  "atsScore": 0,
  "matchedSkills": [],
  "missingSkills": [],
  "improvements": []
}

RESUME:
${resumeText}

JOB DESCRIPTION:
${jobDescription}
`;

    console.log("⏳ Sending request to Gemini...");

    // Timeout protection
    const result = await Promise.race([
      model.generateContent(prompt),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Gemini timeout")), GEMINI_TIMEOUT_MS)
      )
    ]);

    // Robustly extract text from various possible SDK responses
    let raw = "";
    if (typeof result === "string") raw = result;
    else if (result?.response?.text) {
      raw = typeof result.response.text === 'function' ? result.response.text() : result.response.text;
    } else if (result?.outputText) raw = result.outputText;
    else if (result?.outputs && result.outputs[0]) raw = JSON.stringify(result.outputs[0]);
    else raw = String(result);

    raw = raw.replace(/```json|```/g, '').trim();

    console.log("✅ Gemini responded");

    // Try parsing JSON, with fallback to extracting JSON substring
    let analysis;
    try {
      analysis = JSON.parse(raw);
    } catch (e) {
      const m = raw.match(/{[\s\S]*}/);
      console.error('Raw AI response (truncated):', raw.substring(0, 2000));
      if (m) {
        try {
          analysis = JSON.parse(m[0]);
        } catch (err2) {
          throw new Error("Failed to parse AI response as JSON");
        }
      } else {
        throw new Error("Failed to parse AI response as JSON");
      }
    }

    res.json(analysis);

  } catch (error) {
    console.error("🔥 ERROR:", error);

    res.status(500).json({
      atsScore: 50,
      matchedSkills: ["Basic resume structure detected"],
      missingSkills: ["Unable to fully analyze (AI timeout)"],
      improvements: [
        "Retry analysis",
        "Use shorter resume",
        "Ensure text-based PDF"
      ],
      error: error.message
    });
  }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`🚀 Server running on port ${PORT}`));
