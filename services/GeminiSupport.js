const axios = require('axios');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { read, write, id } = require('../lib');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.7-flash';
const API_URL = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;
const ARTIFACT_ROOT = path.join(__dirname, '..', 'data', 'artifacts');
if (!fs.existsSync(ARTIFACT_ROOT)) fs.mkdirSync(ARTIFACT_ROOT, { recursive: true });

const SYSTEM = `You are AM Support AI, the friendly technical customer-service assistant for AM Generator.
Answer in Indonesian unless the user uses another language. Be natural, concise, helpful, and contextual.
You know AM Generator has Dashboard, Userbot, Task, Request Logs, API Keys, Documentation, and an AI Support page.
Never ask for or expose passwords, API keys, tokens, cookies, magic links, or other secrets. If a user pastes a secret, tell them to revoke/rotate it.
When providing code, ALWAYS use fenced Markdown code blocks with the correct language tag (javascript, python, json, html, css, bash, etc.).
When the user asks to create a project/file/package/ZIP, return a PROJECT block in this exact shape after a short explanation:
<PROJECT_JSON>
{"name":"project-name","files":[{"path":"package.json","content":"..."}]}
</PROJECT_JSON>
The files array must contain complete file contents. Do not omit important files with comments like 'rest omitted'. Keep paths relative and safe. You may create JavaScript, TypeScript, Python, HTML, CSS, PHP, JSON, YAML, shell, and other text files.
Do not claim you executed or tested code unless you actually did through an available tool. The website will create the ZIP from the files you provide.`;

function cleanHistory(history) {
  return (Array.isArray(history) ? history : []).slice(-12).filter(x => x && (x.role === 'user' || x.role === 'model'))
    .map(x => ({ role: x.role, parts: [{ text: String(x.text || '').slice(0, 12000) }] }));
}

async function chat({ history = [], message, attachment }) {
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY belum dikonfigurasi di server.');
  const parts = [{ text: String(message || '').slice(0, 16000) }];
  if (attachment?.data && attachment?.mime) {
    const raw = String(attachment.data);
    const base64 = raw.includes(',') ? raw.split(',').pop() : raw;
    if (base64.length > 10 * 1024 * 1024) throw new Error('File terlalu besar. Maksimal sekitar 7 MB untuk mode inline.');
    parts.push({ inlineData: { mimeType: attachment.mime, data: base64 } });
  }
  const contents = [...cleanHistory(history), { role: 'user', parts }];
  const response = await axios.post(API_URL, {
    systemInstruction: { parts: [{ text: SYSTEM }] },
    contents,
    generationConfig: { temperature: 0.35, maxOutputTokens: 8192 }
  }, { params: { key: process.env.GEMINI_API_KEY }, timeout: 120000 });
  const text = response.data?.candidates?.[0]?.content?.parts?.map(p => p.text || '').join('') || '';
  if (!text) throw new Error(response.data?.promptFeedback?.blockReason || 'Gemini tidak mengembalikan respons.');
  return { text, usage: response.data?.usageMetadata || null };
}

function extractProject(text) {
  const match = String(text).match(/<PROJECT_JSON>\s*([\s\S]*?)\s*<\/PROJECT_JSON>/i);
  if (!match) return null;
  try {
    const project = JSON.parse(match[1]);
    if (!project || !Array.isArray(project.files) || !project.files.length) return null;
    project.name = String(project.name || 'am-project').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80) || 'am-project';
    project.files = project.files.map(f => ({ path: safeRelativePath(f.path), content: String(f.content ?? '') })).filter(f => f.path);
    return project;
  } catch { return null; }
}

function safeRelativePath(p) {
  let s = String(p || '').replace(/\\/g, '/').replace(/^\/+/, '');
  s = path.posix.normalize(s);
  if (s === '.' || s.startsWith('../') || s.includes('/../') || /^[A-Za-z]:/.test(s)) return '';
  return s.split('/').filter(Boolean).join('/').slice(0, 240);
}

function createZip(project, userId) {
  const artifactId = id('artifact');
  const dir = path.join(ARTIFACT_ROOT, artifactId);
  fs.mkdirSync(dir, { recursive: true });
  const root = path.join(dir, project.name);
  for (const file of project.files) {
    const target = path.join(root, file.path);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, file.content, 'utf8');
  }
  const zipPath = path.join(dir, `${project.name}.zip`);
  return new Promise((resolve, reject) => {
    const zip = spawn('zip', ['-qr', zipPath, project.name], { cwd: dir });
    let err = '';
    zip.stderr.on('data', d => { err += d.toString(); });
    zip.on('error', reject);
    zip.on('close', code => {
      if (code !== 0) return reject(new Error(err || 'Gagal membuat ZIP.'));
      const artifacts = read('artifacts.json');
      artifacts.push({ id: artifactId, userId, name: project.name, files: project.files.map(f => f.path), zipPath, createdAt: new Date().toISOString() });
      write('artifacts.json', artifacts.slice(-1000));
      resolve({ id: artifactId, name: project.name, files: project.files, zipPath });
    });
  });
}

module.exports = { chat, extractProject, createZip };
