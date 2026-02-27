require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const cors = require('cors');
const http = require('http');
const https = require('https');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const pool = mysql.createPool({
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT, 10) || 3306,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10
});

const OHR_SHEET_ID = process.env.OHR_SHEET_ID || '1KlfU6Juc2vlErxgRoDEGLq6trNIyjqUNMjmr3q7K6vM';
const OHR_SHEET_GID = process.env.OHR_SHEET_GID || '0';
const OHR_SHEET_CSV_URL = process.env.OHR_SHEET_CSV_URL || `https://docs.google.com/spreadsheets/d/${OHR_SHEET_ID}/export?format=csv&gid=${OHR_SHEET_GID}`;
const OHR_TIMESTAMP_WEBHOOK_URL = process.env.OHR_TIMESTAMP_WEBHOOK_URL || '';
const ALLOW_INSECURE_TLS = process.env.ALLOW_INSECURE_TLS === 'true';

function toMySQL(isoString) {
  if (!isoString) return null;
  return isoString.replace('T', ' ').replace('Z', '').split('.')[0];
}

function nowMySQL() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '').split('.')[0];
}

function requireApiKey(req, res, next) {
  const key = req.headers['x-api-key'];
  if (!key || key !== process.env.API_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

function normalizeOhrId(value) {
  return String(value || '').trim().toLowerCase();
}

function splitCSVLine(line) {
  const result = [];
  let current = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];

    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"';
        i += 1;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current);
      current = '';
    } else {
      current += ch;
    }
  }

  result.push(current);
  return result.map((value) => value.trim());
}

function parseAgentCSV(csvText) {
  const lines = (csvText || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (lines.length < 2) {
    return [];
  }

  const headers = splitCSVLine(lines[0]).map((h) => h.replace(/^"|"$/g, '').toLowerCase());
  const ohrIndex = headers.indexOf('agent_ohr');
  const nameIndex = headers.indexOf('agent_name');
  const idIndex = headers.indexOf('id');
  const supervisorIndex = headers.indexOf('supervisor');
  const departmentIndex = headers.indexOf('department');

  if (ohrIndex === -1 || nameIndex === -1) {
    throw new Error('Google Sheet must include agent_ohr and agent_name columns');
  }

  return lines.slice(1).map((line) => {
    const cols = splitCSVLine(line).map((v) => v.replace(/^"|"$/g, ''));
    return {
      id: cols[idIndex] || '',
      agent_ohr: cols[ohrIndex] || '',
      agent_name: cols[nameIndex] || '',
      supervisor: supervisorIndex >= 0 ? (cols[supervisorIndex] || '') : '',
      department: departmentIndex >= 0 ? (cols[departmentIndex] || '') : ''
    };
  });
}

function httpRequest(url, options = {}) {
  const requestUrl = new URL(url);
  const transport = requestUrl.protocol === 'http:' ? http : https;
  const timeoutMs = options.timeoutMs || 10000;

  return new Promise((resolve, reject) => {
    const req = transport.request(
      {
        protocol: requestUrl.protocol,
        hostname: requestUrl.hostname,
        port: requestUrl.port,
        path: `${requestUrl.pathname}${requestUrl.search}`,
        method: options.method || 'GET',
        headers: options.headers || {},
        rejectUnauthorized: !ALLOW_INSECURE_TLS
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', async () => {
          const text = Buffer.concat(chunks).toString('utf8');

          if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
            try {
              const redirectUrl = new URL(res.headers.location, requestUrl.toString()).toString();
              const redirected = await httpRequest(redirectUrl, options);
              resolve(redirected);
              return;
            } catch (err) {
              reject(err);
              return;
            }
          }

          resolve({
            statusCode: res.statusCode || 0,
            headers: res.headers,
            text
          });
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('HTTP request timeout')));

    if (options.body) {
      req.write(options.body);
    }

    req.end();
  });
}

async function fetchSheetText(url) {
  const response = await httpRequest(url);
  if (response.statusCode < 200 || response.statusCode >= 300) {
    throw new Error(`Sheet fetch failed with status ${response.statusCode}`);
  }
  return response.text;
}

async function tryWriteTimestampToWebhook(payload) {
  if (!OHR_TIMESTAMP_WEBHOOK_URL) {
    return { logged: false, status: 'not_configured' };
  }

  try {
    const body = JSON.stringify(payload);
    const response = await httpRequest(OHR_TIMESTAMP_WEBHOOK_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body)
      },
      body
    });

    if (response.statusCode >= 200 && response.statusCode < 300) {
      return { logged: true, status: 'ok' };
    }

    return {
      logged: false,
      status: `webhook_http_${response.statusCode}`
    };
  } catch (err) {
    return {
      logged: false,
      status: `webhook_error:${err.message}`
    };
  }
}

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', timestamp: nowMySQL() });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

app.post('/api/activity-logs', requireApiKey, async (req, res) => {
  try {
    const a = req.body;
    await pool.query(
      `INSERT INTO activity_logs
         (id, agent_id, activity_type, sub_category, url, page_title,
          additional_info, start_time, end_time, duration_seconds,
          manually_categorized, logged_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        a.id || crypto.randomUUID(),
        a.agent_id,
        a.activity_type,
        a.sub_category || null,
        a.url || null,
        a.page_title || null,
        a.additional_info || null,
        toMySQL(a.start_time),
        toMySQL(a.end_time),
        a.duration_seconds || 0,
        a.manually_categorized ? 1 : 0,
        nowMySQL()
      ]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Insert error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent-status', requireApiKey, async (req, res) => {
  try {
    const s = req.body;
    await pool.query(
      `INSERT INTO agent_status
         (agent_id, current_status, current_activity, current_url,
          status_updated_at, last_seen)
       VALUES (?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         current_status    = VALUES(current_status),
         current_activity  = VALUES(current_activity),
         current_url       = VALUES(current_url),
         status_updated_at = VALUES(status_updated_at),
         last_seen         = VALUES(last_seen)`,
      [
        s.agent_id,
        s.current_status,
        s.current_activity,
        s.current_url || '',
        nowMySQL(),
        nowMySQL()
      ]
    );
    res.json({ success: true });
  } catch (err) {
    console.error('Agent status error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/agent-lookup', requireApiKey, async (req, res) => {
  try {
    const requestedOhr = String(req.body?.ohr_id || req.body?.agent_ohr || req.body?.id || '').trim();

    if (!requestedOhr) {
      return res.status(400).json({ success: false, error: 'ohr_id is required' });
    }

    const csvText = await fetchSheetText(OHR_SHEET_CSV_URL);
    const agents = parseAgentCSV(csvText);

    const match = agents.find((agent) => normalizeOhrId(agent.agent_ohr) === normalizeOhrId(requestedOhr));

    if (!match) {
      return res.status(404).json({
        success: false,
        error: 'OHR ID not found',
        requested_ohr: requestedOhr
      });
    }

    const registrationTimestamp = new Date().toISOString();
    const timestampResult = await tryWriteTimestampToWebhook({
      timestamp: registrationTimestamp,
      requested_ohr: requestedOhr,
      agent_ohr: match.agent_ohr,
      agent_name: match.agent_name,
      supervisor: match.supervisor,
      department: match.department
    });

    res.json({
      success: true,
      id: match.id,
      agent_ohr: match.agent_ohr,
      agent_name: match.agent_name,
      supervisor: match.supervisor,
      department: match.department,
      registered_at: registrationTimestamp,
      timestamp_logged: timestampResult.logged,
      timestamp_log_status: timestampResult.status
    });
  } catch (err) {
    console.error('Agent lookup error:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Time Tracker API running on port ${PORT}`);
  console.log(`DB: ${process.env.DB_HOST}/${process.env.DB_NAME}`);
  console.log(`OHR sheet CSV: ${OHR_SHEET_CSV_URL}`);
  if (OHR_TIMESTAMP_WEBHOOK_URL) {
    console.log('OHR timestamp webhook: configured');
  } else {
    console.log('OHR timestamp webhook: not configured');
  }
  if (ALLOW_INSECURE_TLS) {
    console.warn('WARNING: insecure TLS mode enabled (ALLOW_INSECURE_TLS=true)');
  }
});
