/**
 * JOB ALERT BOT (Google Apps Script)
 *
 * Reads LinkedIn job alert emails from Gmail plus the public RSS feeds of
 * Himalayas, Remotive and We Work Remotely. Each new job is checked by Claude
 * for eligibility from your country and for skills fit, logged to a Google Sheet, and the
 * matches are emailed to you.
 *
 * SETUP
 * 1. Create a Google Sheet, then Extensions > Apps Script, and paste this file.
 * 2. Project Settings (gear icon) > Script properties > add ANTHROPIC_API_KEY.
 * 3. Run setup() once and approve the permissions.
 * 4. Edit CONFIG below (especially PROFILE and ROLE_KEYWORDS).
 * 5. Run run() once by hand to test. After that the trigger runs it for you.
 */

const CONFIG = {
  MODEL: 'claude-haiku-5-5',

  // Where you live and work from. Claude uses these to decide if a job is open to you.
  HOME_COUNTRY: 'Kenya',
  HOME_REGION: 'Africa',

  // Leave blank to send to your own Gmail address.
  EMAIL_TO: '',

  // Only jobs you could apply to from your country are kept (explicitly open to
  // your region, worldwide, or timezone-flexible). Restricted jobs are dropped.
  //
  // Jobs from email alerts (LinkedIn, Indeed) only show a title and company, so
  // eligibility cannot be confirmed. They come out as "unclear". Set this to
  // false to drop them, but then LinkedIn and Indeed will rarely give you results.
  INCLUDE_UNCLEAR_EMAIL: true,
  // Feed jobs with no location info at all. Usually safer to leave off.
  INCLUDE_UNCLEAR_FEEDS: false,

  // Skills fit score (0 to 10). Eligible jobs scoring at least LOG_MIN_FIT are
  // saved to the Jobs sheet. Jobs scoring at least MIN_FIT are also emailed.
  LOG_MIN_FIT: 5,
  MIN_FIT: 6,

  // Set true to also keep the jobs that were dropped, in a "Rejected" sheet.
  LOG_REJECTED: false,

  // Safety limits per run.
  MAX_CLAUDE_CALLS_PER_RUN: 30,
  MAX_RUNTIME_MS: 5 * 60 * 1000,

  // Job alert emails in your Gmail. For each source:
  //   query: the Gmail search that finds its alert emails
  //   idRegex: pulls the job id out of a link in the email (first group)
  //   link: builds a clean, stable link from that id
  // To add another site with email alerts (Glassdoor, etc.), copy a block.
  EMAIL_SOURCES: [
    {
      name: 'LinkedIn',
      query: '(from:jobalerts-noreply@linkedin.com OR from:jobs-noreply@linkedin.com) newer_than:2d',
      idRegex: /\/jobs\/view\/(\d+)/,
      link: function (id) { return 'https://www.linkedin.com/jobs/view/' + id; }
    },
    {
      name: 'Indeed',
      query: 'from:indeed.com newer_than:2d',
      idRegex: /[?&]jk=([0-9a-f]+)/i,
      link: function (id) { return 'https://www.indeed.com/viewjob?jk=' + id; }
    }
  ],

  // Remote OK's public feed (the latest ~100 jobs, full descriptions).
  USE_REMOTE_OK: true,

  FEEDS: [
    { name: 'Himalayas', url: 'https://himalayas.app/jobs/rss' },
    { name: 'Remotive', url: 'https://remotive.com/feed' },
    { name: 'We Work Remotely', url: 'https://weworkremotely.com/remote-jobs.rss' },
    { name: 'Jobicy', url: 'https://jobicy.com/jobs/feed' }
  ],

  // A job is only sent to Claude if its title or text contains one of these.
  // This keeps costs down. Set to [] to send everything.
  ROLE_KEYWORDS: [
    'ai', 'automation', 'operations', 'project', 'coordinator', 'annotation',
    'llm', 'training', 'quality', 'evaluator', 'rater', 'data', 'n8n',
    'policy', 'research', 'analyst', 'virtual assistant', 'program', 'community'
  ],

  // EDIT THIS. Tells Claude who you are so it can score fit.
  // Be accurate. Claude scores jobs against exactly what you write here.
  PROFILE: 'Based in [your city, country, timezone], looking for remote work. ' +
    'Experience: [your roles and the kind of work you have actually done]. ' +
    'Tools and skills: [what you genuinely use]. ' +
    'Gaps: [anything you want weak-fit roles scored lower for].'
};

/* ------------------------------------------------------------------ */
/* Setup                                                               */
/* ------------------------------------------------------------------ */

function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, 'Jobs', [
    'Found', 'Source', 'Title', 'Company and location', 'Link', 'Eligibility', 'Fit',
    'Timezone', 'Contractor ok', 'Skills gap', 'Evidence', 'Summary', 'Emailed'
  ]);
  ensureSheet_(ss, 'Seen', ['Link', 'Date']);

  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'run') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('run').timeBased().everyMinutes(30).create();
  console.log('Setup done. Trigger created: run() every 30 minutes.');
}

function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}

/* ------------------------------------------------------------------ */
/* Main                                                                */
/* ------------------------------------------------------------------ */

function run() {
  const start = Date.now();
  const key = PropertiesService.getScriptProperties().getProperty('ANTHROPIC_API_KEY');
  if (!key) throw new Error('Add ANTHROPIC_API_KEY under Project Settings > Script properties.');

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const jobsSheet = ensureSheet_(ss, 'Jobs', []);
  const seenSheet = ensureSheet_(ss, 'Seen', ['Link', 'Date']);

  // Load links we have already handled.
  const seen = new Set();
  const lastSeenRow = seenSheet.getLastRow();
  if (lastSeenRow > 1) {
    seenSheet.getRange(2, 1, lastSeenRow - 1, 1).getValues().forEach(function (r) { seen.add(r[0]); });
  }

  // Gather candidates from every source. One failing source never stops the rest.
  let candidates = [];
  CONFIG.FEEDS.forEach(function (feed) {
    try { candidates = candidates.concat(fetchFeed_(feed)); }
    catch (e) { console.warn('Feed failed: ' + feed.name + ' - ' + e); }
  });
  CONFIG.EMAIL_SOURCES.forEach(function (src) {
    try { candidates = candidates.concat(fetchEmailSource_(src)); }
    catch (e) { console.warn('Email alerts failed: ' + src.name + ' - ' + e); }
  });
  if (CONFIG.USE_REMOTE_OK) {
    try { candidates = candidates.concat(fetchRemoteOk_()); }
    catch (e) { console.warn('Remote OK failed: ' + e); }
  }

  // Drop duplicates and anything already handled.
  const unique = {};
  candidates.forEach(function (j) {
    if (j.link && !seen.has(j.link) && !unique[j.link]) unique[j.link] = j;
  });
  const fresh = Object.keys(unique).map(function (k) { return unique[k]; });
  console.log('New candidates: ' + fresh.length);

  const nowStr = new Date();
  const newSeen = [];
  const newRows = [];
  const matches = [];
  const rejectedRows = [];
  let calls = 0;

  try {
    for (let i = 0; i < fresh.length; i++) {
      const job = fresh[i];
      if (Date.now() - start > CONFIG.MAX_RUNTIME_MS) break;

      if (!passesKeywords_(job)) {
        newSeen.push([job.link, nowStr]);
        continue;
      }
      if (calls >= CONFIG.MAX_CLAUDE_CALLS_PER_RUN) break; // rest wait for the next run
      calls++;

      const res = classify_(job, key);
      if (res.httpError) break; // do not mark as seen, try again next run
      newSeen.push([job.link, nowStr]);
      if (!res.data) continue;

      const d = res.data;
      const fit = Number(d.fit_score) || 0;
      const elig = d.eligibility || '';
      const placeInfo = [d.company, d.location_summary].filter(String).join(' | ') || job.info || '';

      const clearlyEligible = elig === 'region_explicit' || elig === 'worldwide' || elig === 'timezone_limited';
      const unclearAllowed = elig === 'unclear' &&
        (job.fromEmail ? CONFIG.INCLUDE_UNCLEAR_EMAIL : CONFIG.INCLUDE_UNCLEAR_FEEDS);
      const locationOk = clearlyEligible || unclearAllowed;

      const keep = locationOk && fit >= CONFIG.LOG_MIN_FIT;
      const emailIt = keep && fit >= CONFIG.MIN_FIT;

      const row = [
        nowStr, job.source, job.title, placeInfo, job.link,
        elig, fit, d.timezone || '', d.contractor_ok || '',
        d.skills_gap || '', d.evidence || '', d.summary || '', emailIt ? 'yes' : 'no'
      ];
      if (keep) newRows.push(row);
      else if (CONFIG.LOG_REJECTED) rejectedRows.push(row);
      if (emailIt) matches.push({ job: job, d: d, fit: fit });
    }
  } finally {
    // Always save progress, even if something above threw.
    if (newRows.length) {
      jobsSheet.getRange(jobsSheet.getLastRow() + 1, 1, newRows.length, newRows[0].length).setValues(newRows);
    }
    if (rejectedRows.length) {
      const rej = ensureSheet_(ss, 'Rejected', [
        'Found', 'Source', 'Title', 'Company and location', 'Link', 'Eligibility', 'Fit',
        'Timezone', 'Contractor ok', 'Skills gap', 'Evidence', 'Summary', 'Emailed'
      ]);
      rej.getRange(rej.getLastRow() + 1, 1, rejectedRows.length, rejectedRows[0].length).setValues(rejectedRows);
    }
    if (newSeen.length) {
      seenSheet.getRange(seenSheet.getLastRow() + 1, 1, newSeen.length, 2).setValues(newSeen);
    }
  }

  if (matches.length) sendDigest_(matches);
  console.log('Claude calls: ' + calls + ', matches: ' + matches.length);
}

function passesKeywords_(job) {
  if (!CONFIG.ROLE_KEYWORDS.length) return true;
  const hay = (job.title + ' ' + job.text + ' ' + (job.extras || '')).toLowerCase();
  return CONFIG.ROLE_KEYWORDS.some(function (kw) {
    const safe = kw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp('\\b' + safe + '\\b', 'i').test(hay);
  });
}

/* ------------------------------------------------------------------ */
/* Sources                                                             */
/* ------------------------------------------------------------------ */

function fetchFeed_(feed) {
  const resp = UrlFetchApp.fetch(feed.url, {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (personal job alert script)' }
  });
  if (resp.getResponseCode() !== 200) {
    console.warn(feed.name + ' returned HTTP ' + resp.getResponseCode());
    return [];
  }
  const doc = XmlService.parse(resp.getContentText());
  const elements = [];
  collectItems_(doc.getRootElement(), elements);

  return elements.map(function (el) { return itemToJob_(el, feed.name); })
    .filter(function (j) { return j.link && j.title; });
}

// Works for both RSS (item) and Atom (entry) feeds.
function collectItems_(el, out) {
  const n = el.getName().toLowerCase();
  if (n === 'item' || n === 'entry') { out.push(el); return; }
  el.getChildren().forEach(function (c) { collectItems_(c, out); });
}

function itemToJob_(el, source) {
  let title = '', link = '', body = '';
  const extras = [];
  const skip = ['guid', 'id', 'pubdate', 'updated', 'published', 'author', 'enclosure'];

  el.getChildren().forEach(function (c) {
    const name = c.getName().toLowerCase();
    const text = (c.getText() || '').trim();
    if (name === 'title') {
      title = stripHtml_(text);
    } else if (name === 'link') {
      const href = c.getAttribute('href');
      if (href) { if (!link) link = href.getValue(); }
      else if (text) { link = text; }
    } else if (name === 'description' || name === 'content' || name === 'summary') {
      if (!body) body = stripHtml_(text);
    } else if (text && text.length < 300 && skip.indexOf(name) === -1) {
      // Catches useful extras such as region or location restrictions.
      extras.push(name + ': ' + stripHtml_(text));
    }
  });

  return {
    source: source, title: title, link: link, text: body,
    extras: extras.join('; '), info: extras.join('; ').substr(0, 200)
  };
}

function fetchEmailSource_(src) {
  const threads = GmailApp.search(src.query, 0, 50);
  const found = {};
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;

  threads.forEach(function (t) {
    t.getMessages().forEach(function (m) {
      const html = m.getBody();
      let match;
      re.lastIndex = 0;
      while ((match = re.exec(html)) !== null) {
        const href = match[1].replace(/&amp;/g, '&');
        const idMatch = src.idRegex.exec(href);
        if (!idMatch) continue;
        const id = idMatch[1];
        const title = stripHtml_(match[2]);
        if (!title || /^(view|apply|see|easily apply)\b/i.test(title)) continue;
        const context = stripHtml_(html.substr(re.lastIndex, 500)).substr(0, 200);
        const prev = found[id];
        if (!prev || title.length > prev.title.length) {
          found[id] = {
            source: src.name,
            fromEmail: true,
            title: title,
            link: src.link(id),
            text: context, // company and location, usually
            extras: '',
            info: context
          };
        }
      }
    });
  });
  return Object.keys(found).map(function (k) { return found[k]; });
}

function fetchRemoteOk_() {
  const resp = UrlFetchApp.fetch('https://remoteok.com/api', {
    muteHttpExceptions: true,
    headers: { 'User-Agent': 'Mozilla/5.0 (personal job alert script)' }
  });
  if (resp.getResponseCode() !== 200) {
    console.warn('Remote OK returned HTTP ' + resp.getResponseCode());
    return [];
  }
  const arr = JSON.parse(resp.getContentText());
  return arr.filter(function (j) { return j && j.id && j.position; }).map(function (j) {
    const extras = 'location: ' + (j.location || 'not stated') +
      (j.tags && j.tags.length ? '; tags: ' + j.tags.join(', ') : '');
    return {
      source: 'Remote OK',
      title: j.position + (j.company ? ' at ' + j.company : ''),
      link: j.url || ('https://remoteok.com/remote-jobs/' + j.id),
      text: stripHtml_(j.description || ''),
      extras: extras,
      info: extras.substr(0, 200)
    };
  });
}

// Troubleshooting helper: run this by hand if a source finds nothing.
// It prints the links found in the newest alert email for that source.
function debugEmailLinks() {
  const sourceName = 'Indeed'; // change to 'LinkedIn' to test that one
  const src = CONFIG.EMAIL_SOURCES.filter(function (s) { return s.name === sourceName; })[0];
  const threads = GmailApp.search(src.query, 0, 1);
  if (!threads.length) { console.log('No emails found for query: ' + src.query); return; }
  const msg = threads[0].getMessages().pop();
  console.log('Sender: ' + msg.getFrom() + ' | Subject: ' + msg.getSubject());
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const html = msg.getBody();
  let m, n = 0;
  while ((m = re.exec(html)) !== null && n < 15) {
    console.log(stripHtml_(m[2]).substr(0, 60) + '  ->  ' + m[1].substr(0, 140));
    n++;
  }
}

/* ------------------------------------------------------------------ */
/* Claude                                                              */
/* ------------------------------------------------------------------ */

function classify_(job, key) {
  const system =
    'You screen remote job postings for one candidate.\n' +
    'Candidate: ' + CONFIG.PROFILE + '\n\n' +
    'Reply with ONLY a JSON object, no other text:\n' +
    '{\n' +
    '  "eligibility": "region_explicit" | "worldwide" | "timezone_limited" | "unclear" | "restricted",\n' +
    '  "fit_score": integer 0 to 10,\n' +
    '  "timezone": string,\n' +
    '  "contractor_ok": "yes" | "no" | "unclear",\n' +
    '  "skills_gap": string,\n' +
    '  "company": string,\n' +
    '  "location_summary": string,\n' +
    '  "evidence": string,\n' +
    '  "summary": string\n' +
    '}\n\n' +
    'Rules:\n' +
    '- region_explicit: the posting says ' + CONFIG.HOME_REGION + ', countries in ' + CONFIG.HOME_REGION + ', or ' + CONFIG.HOME_COUNTRY + ' is welcome or eligible.\n' +
    '- worldwide: the posting says worldwide, anywhere, or global, with no country limits.\n' +
    '- timezone_limited: open to many countries but needs overlap with a specific timezone.\n' +
    '- restricted: limited to countries or regions that exclude ' + CONFIG.HOME_COUNTRY + ', requires residency or work authorization the candidate does not have, or is onsite or hybrid.\n' +
    '- unclear: the text does not say. This is common when only a title and company are available. Use it instead of guessing.\n' +
    '- evidence: copy, word for word, the one sentence from the posting that best supports your eligibility call. Empty string if there is none. Never paraphrase or invent.\n' +
    '- fit_score reflects how well the candidate\'s skills and experience match the role, regardless of location.\n' +
    '- skills_gap: the main skills, tools, or experience the posting requires that the candidate appears to lack. One short sentence. Empty string if there is no real gap. Do not mention location here.\n' +
    '- company: the hiring company name if stated, otherwise an empty string.\n' +
    '- location_summary: a few words on where the job can be done from, for example "Worldwide" or "Europe only".\n' +
    '- summary: one plain sentence on what the job is.';

  const user =
    'Source: ' + job.source + '\n' +
    'Title: ' + job.title + '\n' +
    (job.extras ? 'Details: ' + job.extras + '\n' : '') +
    '\nPosting text:\n' + job.text.substr(0, 6000);

  const resp = UrlFetchApp.fetch('https://api.anthropic.com/v1/messages', {
    method: 'post',
    contentType: 'application/json',
    muteHttpExceptions: true,
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    payload: JSON.stringify({
      model: CONFIG.MODEL,
      max_tokens: 600,
      system: system,
      messages: [{ role: 'user', content: user }]
    })
  });

  if (resp.getResponseCode() !== 200) {
    console.error('Claude API error ' + resp.getResponseCode() + ': ' + resp.getContentText().substr(0, 300));
    return { httpError: true };
  }

  try {
    const body = JSON.parse(resp.getContentText());
    let text = (body.content || []).map(function (b) { return b.text || ''; }).join('');
    text = text.replace(/```json|```/g, '');
    const s = text.indexOf('{');
    const e = text.lastIndexOf('}');
    return { data: JSON.parse(text.substring(s, e + 1)) };
  } catch (err) {
    console.warn('Could not parse Claude reply for ' + job.link + ': ' + err);
    return { data: null };
  }
}

/* ------------------------------------------------------------------ */
/* Email digest                                                        */
/* ------------------------------------------------------------------ */

function sendDigest_(matches) {
  const order = { region_explicit: 0, worldwide: 1, timezone_limited: 2, unclear: 3 };
  const labels = {
    region_explicit: 'Explicitly open to ' + CONFIG.HOME_REGION,
    worldwide: 'Worldwide',
    timezone_limited: 'Timezone overlap needed',
    unclear: 'Eligibility unclear, check the posting'
  };

  matches.sort(function (a, b) {
    const oa = order[a.d.eligibility] !== undefined ? order[a.d.eligibility] : 9;
    const ob = order[b.d.eligibility] !== undefined ? order[b.d.eligibility] : 9;
    return oa - ob || b.fit - a.fit;
  });

  let html = '<div style="font-family:Arial,sans-serif;max-width:640px">';
  let text = '';
  let lastGroup = null;

  matches.forEach(function (m) {
    const group = labels[m.d.eligibility] || 'Other';
    if (group !== lastGroup) {
      html += '<h3 style="margin:24px 0 8px;border-bottom:1px solid #ddd;padding-bottom:4px">' + esc_(group) + '</h3>';
      text += '\n== ' + group + ' ==\n';
      lastGroup = group;
    }
    html += '<div style="margin-bottom:16px">' +
      '<a href="' + esc_(m.job.link) + '" style="font-size:15px;font-weight:bold">' + esc_(m.job.title) + '</a>' +
      '<div style="color:#666;font-size:12px">' + esc_(m.job.source) + ' | fit ' + m.fit + '/10' +
      (m.d.timezone ? ' | ' + esc_(m.d.timezone) : '') +
      (m.d.contractor_ok && m.d.contractor_ok !== 'unclear' ? ' | contractor ok: ' + esc_(m.d.contractor_ok) : '') + '</div>' +
      (m.d.summary ? '<div style="margin-top:4px">' + esc_(m.d.summary) + '</div>' : '') +
      (m.d.evidence ? '<div style="margin-top:4px;color:#333"><i>"' + esc_(m.d.evidence) + '"</i></div>' : '') +
      (m.d.skills_gap ? '<div style="margin-top:4px;color:#b00">Skills gap: ' + esc_(m.d.skills_gap) + '</div>' : '') +
      '</div>';
    text += '\n' + m.job.title + ' (' + m.job.source + ', fit ' + m.fit + '/10)\n' + m.job.link + '\n' +
      (m.d.summary ? m.d.summary + '\n' : '') +
      (m.d.evidence ? '"' + m.d.evidence + '"\n' : '') +
      (m.d.skills_gap ? 'Skills gap: ' + m.d.skills_gap + '\n' : '');
  });
  html += '</div>';

  MailApp.sendEmail({
    to: CONFIG.EMAIL_TO || Session.getEffectiveUser().getEmail(),
    subject: 'Job alerts: ' + matches.length + ' new match' + (matches.length === 1 ? '' : 'es'),
    body: text,
    htmlBody: html
  });
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function stripHtml_(s) {
  return String(s || '')
    .replace(/<br\s*\/?>|<\/p>|<\/li>|<\/div>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&middot;/gi, ' | ')
    .replace(/&#x([0-9a-f]+);/gi, function (m, h) { return String.fromCharCode(parseInt(h, 16)); })
    .replace(/&#(\d+);/g, function (m, d) { return String.fromCharCode(parseInt(d, 10)); })
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
}

function esc_(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
