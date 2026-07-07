const admin = require('firebase-admin');
const { chromium: pw } = require('playwright');

const svcAccount = JSON.parse(Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT_B64, 'base64').toString('utf8'));
admin.initializeApp({ credential: admin.credential.cert(svcAccount) });
const db = admin.firestore();

const TOKEN_ENDPOINT = 'https://sso.sa.edenred.io/connect/token';
const CLIENT_ID = 'fcfc49a2ff3b45ef9c5f245b37b4d567';
const SCOPE = 'openid profile email portal-fleet-and-mobility-ms_application-mfa offline_access';
const FORM_LINK = Buffer.from('GoodManagerSSL/Fuel/FuelRelResumidoConsumoForm.cfm').toString('base64');

async function getTokens() {
  const ref = db.collection('ticketlog_auth').doc('sessao');
  const snap = await ref.get();
  const candidates = [];
  if (snap.exists && snap.data().refreshToken) candidates.push(snap.data().refreshToken);
  if (process.env.TICKETLOG_REFRESH_SEED) candidates.push(process.env.TICKETLOG_REFRESH_SEED);
  if (!candidates.length) throw new Error('Sem refresh_token no Firestore nem TICKETLOG_REFRESH_SEED');
  let lastErr = '';
  for (const refreshToken of candidates) {
    const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: CLIENT_ID, scope: SCOPE });
    const r = await fetch(TOKEN_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
    if (r.ok) {
      const t = await r.json();
      await ref.set({ refreshToken: t.refresh_token, updatedAt: admin.firestore.FieldValue.serverTimestamp() }, { merge: true });
      return t;
    }
    lastErr = r.status + ': ' + (await r.text()).slice(0, 120);
  }
  throw new Error('Refresh falhou em todos os tokens. Ultimo: ' + lastErr);
}

function buildPostBody() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (d) => `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()}`;
  const firstDay = new Date(now.getFullYear(), now.getMonth(), 1);
  return new URLSearchParams({
    nr_cartao: '', dt_ini: fmt(firstDay), dt_fim: fmt(now),
    ds_placa: '', cd_veiculo_modelo: '', fl_controle: 'T',
    cd_tipo_frota: '', nr_frota: '', cd_familia_veiculo: '',
    cd_tipo_combustivel: '', Exibe: 'H',
  }).toString();
}

function parse(html) {
  const num = (s) => parseFloat(String(s).replace(/\./g, '').replace(',', '.')) || 0;
  const rows = [];
  let rowLog = 0;
  for (const chunk of html.split(/<tr/i).slice(1)) {
    const tds = [...chunk.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/gi)].map((m) => m[1].replace(/<[^>]*>/g, '').replace(/&nbsp;/g, ' ').trim());
    if (tds.length >= 5 && rowLog++ < 5) console.log('[TL parse] row tds:', JSON.stringify(tds.slice(0, 12)));
    if (tds.length >= 10 && /^[A-Z]{3}\d[A-Z0-9]\d\d$/.test(tds[0])) {
      rows.push({ placa: tds[0], limite: num(tds[7]), saldo: num(tds[8]), quilometragem: num(tds[9]) });
    }
  }
  return rows;
}

async function main() {
  let browser;
  try {
    const tok = await getTokens();
    console.log('[TL] tokens ok, access_token len:', tok.access_token?.length);
    console.log('[TL] launching browser...');
    browser = await pw.launch({
      args: ['--no-sandbox', '--disable-dev-shm-usage', '--single-process'],
      headless: true,
    });
    console.log('[TL] browser launched');
    const page = await (await browser.newContext()).newPage();
    await page.addInitScript((t) => {
      try {
        localStorage.setItem('access_token', t.a);
        localStorage.setItem('id_token', t.i);
        localStorage.setItem('refresh_token', t.r);
      } catch (e) {}
    }, { a: tok.access_token, i: tok.id_token, r: tok.refresh_token });
    await page.goto('https://plataforma.ticketlog.com.br/home', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.goto('https://plataforma.ticketlog.com.br/legacy?link=' + FORM_LINK, { waitUntil: 'domcontentloaded', timeout: 60000 });
    const frame = page.frames().find((f) => f.url().includes('legacy-soulog'));
    console.log('[TL] frame url:', frame ? frame.url() : 'NOT FOUND | frames: ' + page.frames().map((f) => f.url()).join(', '));
    if (!frame) throw new Error('iframe legacy nao encontrado');
    const postBody = buildPostBody();
    const html = await frame.evaluate(async (body) => {
      const r = await fetch('https://legacy-soulog.ticketlog.com.br/GoodManagerSSL/Fuel/FuelRelResumidoConsumoLista.cfm?RequestTimeOut=360', {
        method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body,
      });
      return await r.text();
    }, postBody);
    console.log('[TL] html len:', html.length, '| preview:', html.slice(0, 300).replace(/\s+/g, ' '));
    const rows = parse(html);
    console.log('[TL] rows parsed:', rows.length, rows.length ? JSON.stringify(rows[0]) : 'none');
    if (!rows.length) throw new Error('parser sem linhas; html len ' + html.length);
    const batch = db.batch();
    const now = admin.firestore.FieldValue.serverTimestamp();
    for (const v of rows) {
      batch.set(db.collection('frota_consumo').doc(v.placa), {
        placa: v.placa, limite: v.limite, saldo: v.saldo, quilometragem: v.quilometragem, atualizadoEm: now,
      }, { merge: true });
    }
    await batch.commit();
    console.log('[TL] committed', rows.length, 'docs to frota_consumo');
  } finally {
    if (browser) await browser.close();
    await admin.app().delete();
  }
}

main().catch((e) => {
  console.error('[TL] ERROR:', String(e));
  process.exit(1);
});
